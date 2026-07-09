use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LetsEncryptConfig {
    pub email: String,
    pub staging: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificatePaths {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
}

#[derive(Default)]
pub(crate) struct ChallengeStore {
    values: RwLock<HashMap<String, String>>,
}

impl ChallengeStore {
    pub(crate) fn insert(&self, token: String, value: String) {
        let mut values = self
            .values
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        values.insert(token, value);
    }

    pub(crate) fn get(&self, token: &str) -> Option<String> {
        let values = self
            .values
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        values.get(token).cloned()
    }

    pub(crate) fn remove(&self, token: &str) {
        let mut values = self
            .values
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        values.remove(token);
    }
}

#[cfg(unix)]
mod imp {
    use super::{CertificatePaths, ChallengeStore, LetsEncryptConfig};
    use anyhow::{bail, Context, Result};
    use instant_acme::{
        Account, AccountCredentials, AuthorizationStatus, ChallengeType, CryptoProvider,
        DefaultClient, Identifier, LetsEncrypt, NewAccount, NewOrder, OrderStatus, RetryPolicy,
    };
    use openssl::asn1::Asn1Time;
    use openssl::x509::X509;
    use std::cmp::Ordering;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    const ACME_DIR_ENV: &str = "RATHOLE_ACME_DIR";
    const RENEW_BEFORE_DAYS: u32 = 30;

    pub(crate) struct AcmeIssuer {
        challenges: Arc<ChallengeStore>,
        storage_dir: PathBuf,
    }

    impl AcmeIssuer {
        pub(crate) fn new(challenges: Arc<ChallengeStore>) -> Self {
            Self {
                challenges,
                storage_dir: default_storage_dir(),
            }
        }

        pub(crate) async fn ensure_certificate(
            &self,
            config: &LetsEncryptConfig,
            domains: &[String],
        ) -> Result<CertificatePaths> {
            let domains = normalize_domains(domains)?;
            let environment_dir = self.storage_dir.join(environment_name(config.staging));
            let cert_dir = environment_dir.join(sanitize_path_part(&domains[0]));
            let paths = CertificatePaths {
                cert_path: cert_dir.join("fullchain.pem"),
                key_path: cert_dir.join("key.pem"),
            };
            let domains_path = cert_dir.join("domains.txt");

            if certificate_is_fresh(&paths, &domains_path, &domains)? {
                return Ok(paths);
            }

            fs::create_dir_all(&cert_dir)
                .with_context(|| format!("creating ACME certificate directory {}", cert_dir.display()))?;
            fs::create_dir_all(&environment_dir)
                .with_context(|| format!("creating ACME account directory {}", environment_dir.display()))?;

            tracing::info!(
                domains = ?domains,
                staging = config.staging,
                "requesting Let's Encrypt certificate"
            );
            let account = load_or_create_account(config, &environment_dir).await?;
            let (certificate_pem, private_key_pem) =
                self.issue_certificate(&account, &domains).await?;

            write_atomic(&paths.cert_path, certificate_pem.as_bytes())
                .with_context(|| format!("writing {}", paths.cert_path.display()))?;
            write_secret_atomic(&paths.key_path, private_key_pem.as_bytes())
                .with_context(|| format!("writing {}", paths.key_path.display()))?;
            write_atomic(&domains_path, domains.join("\n").as_bytes())
                .with_context(|| format!("writing {}", domains_path.display()))?;

            Ok(paths)
        }

        async fn issue_certificate(
            &self,
            account: &Account,
            domains: &[String],
        ) -> Result<(String, String)> {
            let identifiers = domains
                .iter()
                .map(|domain| Identifier::Dns(domain.clone()))
                .collect::<Vec<_>>();
            let mut order = account
                .new_order(&NewOrder::new(identifiers.as_slice()))
                .await
                .context("creating ACME order")?;

            let mut active_tokens = Vec::new();
            let result = async {
                let mut authorizations = order.authorizations();
                while let Some(result) = authorizations.next().await {
                    let mut authz = result.context("fetching ACME authorization")?;
                    match authz.status {
                        AuthorizationStatus::Pending => {}
                        AuthorizationStatus::Valid => continue,
                        other => bail!("ACME authorization is {other:?}"),
                    }

                    let mut challenge = authz
                        .challenge(ChallengeType::Http01)
                        .context("ACME server did not offer an HTTP-01 challenge")?;
                    let token = challenge.token.clone();
                    let key_authorization = challenge
                        .key_authorization()
                        .context("building ACME HTTP-01 key authorization")?
                        .as_str()
                        .to_string();
                    self.challenges.insert(token.clone(), key_authorization);
                    active_tokens.push(token);
                    challenge
                        .set_ready()
                        .await
                        .context("marking ACME HTTP-01 challenge ready")?;
                }

                let retry = RetryPolicy::default().timeout(Duration::from_secs(90));
                let status = order
                    .poll_ready(&retry)
                    .await
                    .context("waiting for ACME validations")?;
                if status != OrderStatus::Ready {
                    bail!("ACME order ended in unexpected state {status:?}");
                }

                let private_key_pem = order.finalize().await.context("finalizing ACME order")?;
                let certificate_pem = order
                    .poll_certificate(&retry)
                    .await
                    .context("downloading ACME certificate")?;
                Ok((certificate_pem, private_key_pem))
            }
            .await;

            for token in active_tokens {
                self.challenges.remove(&token);
            }

            result
        }
    }

    async fn load_or_create_account(
        config: &LetsEncryptConfig,
        environment_dir: &Path,
    ) -> Result<Account> {
        let credentials_path = environment_dir.join("account.json");
        let builder = account_builder()?;
        if credentials_path.exists() {
            let credentials = fs::read(&credentials_path)
                .with_context(|| format!("reading {}", credentials_path.display()))
                .and_then(|bytes| {
                    serde_json::from_slice::<AccountCredentials>(&bytes)
                        .context("parsing ACME account credentials")
                })?;
            return builder
                .from_credentials(credentials)
                .await
                .context("loading ACME account credentials");
        }

        let contact = format!("mailto:{}", config.email);
        let contacts = [contact.as_str()];
        let directory_url = if config.staging {
            LetsEncrypt::Staging.url()
        } else {
            LetsEncrypt::Production.url()
        };
        let (account, credentials) = builder
            .create(
                &NewAccount {
                    contact: &contacts,
                    terms_of_service_agreed: true,
                    only_return_existing: false,
                },
                directory_url.to_owned(),
                None,
            )
            .await
            .context("creating ACME account")?;

        let json = serde_json::to_vec_pretty(&credentials).context("serializing ACME account")?;
        write_secret_atomic(&credentials_path, &json)
            .with_context(|| format!("writing {}", credentials_path.display()))?;
        Ok(account)
    }

    fn account_builder() -> Result<instant_acme::AccountBuilder> {
        let provider = CryptoProvider::aws_lc_rs();
        let rustls_provider = rustls::crypto::aws_lc_rs::default_provider();
        Account::builder(
            Box::new(DefaultClient::new(Arc::new(rustls_provider))?),
            provider,
        )
        .context("building ACME account client")
    }

    fn certificate_is_fresh(
        paths: &CertificatePaths,
        domains_path: &Path,
        domains: &[String],
    ) -> Result<bool> {
        if !paths.cert_path.exists() || !paths.key_path.exists() {
            return Ok(false);
        }
        if read_domains(domains_path).as_deref() != Some(domains) {
            return Ok(false);
        }

        let cert_pem = match fs::read(&paths.cert_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(path = %paths.cert_path.display(), ?error, "failed to read existing ACME certificate");
                return Ok(false);
            }
        };
        let cert = match X509::from_pem(&cert_pem) {
            Ok(cert) => cert,
            Err(error) => {
                tracing::warn!(path = %paths.cert_path.display(), ?error, "failed to parse existing ACME certificate");
                return Ok(false);
            }
        };
        let threshold =
            Asn1Time::days_from_now(RENEW_BEFORE_DAYS).context("computing certificate renewal threshold")?;
        Ok(cert
            .not_after()
            .compare(&threshold)
            .context("checking ACME certificate expiry")?
            == Ordering::Greater)
    }

    fn read_domains(path: &Path) -> Option<Vec<String>> {
        let text = fs::read_to_string(path).ok()?;
        let mut domains = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        domains.sort();
        domains.dedup();
        Some(domains)
    }

    fn normalize_domains(domains: &[String]) -> Result<Vec<String>> {
        let mut normalized = domains
            .iter()
            .map(|domain| domain.trim().trim_end_matches('.').to_ascii_lowercase())
            .filter(|domain| !domain.is_empty())
            .collect::<Vec<_>>();
        normalized.sort();
        normalized.dedup();
        if normalized.is_empty() {
            bail!("Let's Encrypt requires at least one HTTP host");
        }
        if normalized.iter().any(|domain| domain.starts_with("*.")) {
            bail!("Let's Encrypt HTTP-01 cannot issue wildcard certificates");
        }
        Ok(normalized)
    }

    fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating directory {}", parent.display()))?;
        }
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
        fs::rename(&tmp, path)
            .with_context(|| format!("renaming {} to {}", tmp.display(), path.display()))?;
        Ok(())
    }

    fn write_secret_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
        write_atomic(path, bytes)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("setting permissions on {}", path.display()))?;
        Ok(())
    }

    fn default_storage_dir() -> PathBuf {
        if let Some(path) = std::env::var_os(ACME_DIR_ENV) {
            return PathBuf::from(path);
        }
        if let Ok(state_directory) = std::env::var("STATE_DIRECTORY") {
            if let Some(first) = state_directory.split(':').find(|part| !part.is_empty()) {
                return PathBuf::from(first).join("acme");
            }
        }
        PathBuf::from("/var/lib/rathole-manage/acme")
    }

    fn environment_name(staging: bool) -> &'static str {
        if staging {
            "staging"
        } else {
            "production"
        }
    }

    fn sanitize_path_part(value: &str) -> String {
        let sanitized = value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '.' {
                    ch
                } else {
                    '_'
                }
            })
            .collect::<String>()
            .trim_matches('.')
            .to_string();
        if sanitized.is_empty() {
            "default".into()
        } else {
            sanitized
        }
    }
}

#[cfg(unix)]
pub(crate) use imp::AcmeIssuer;
