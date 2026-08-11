// Most of this module is Unix-only (instant-acme and pingora are), so the
// shared types below read as dead code on other platforms.
#![cfg_attr(not(unix), allow(dead_code))]

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

/// What inspecting the certificate on disk told us.
///
/// `not_after_ms` is only available once the PEM has actually been parsed, so it
/// stays `None` for a missing, unreadable or superseded certificate — which is
/// why this is a struct rather than a `(bool, u64)`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CertificateFacts {
    /// Usable as-is: present, matched by its key, covers exactly the requested
    /// SAN set, and outside the renewal window.
    pub fresh: bool,
    /// Expiry, epoch ms. `None` when no certificate could be parsed.
    pub not_after_ms: Option<u64>,
    /// SAN set the certificate on disk actually covers, which is not necessarily
    /// the set that was just requested. `None` when it could not be read.
    pub covered_domains: Option<Vec<String>>,
    /// Why it is not fresh, for logs and status. `None` when it is.
    pub reason: Option<&'static str>,
}

/// Result of an `ensure_certificate` call.
#[derive(Debug, Clone)]
pub struct CertificateOutcome {
    /// Where the certificate lives, when there is a usable one.
    pub paths: Option<CertificatePaths>,
    pub facts: CertificateFacts,
    /// Whether this call actually wrote new certificate bytes.
    pub renewed: bool,
    /// Issuance error, when the attempt failed.
    pub error: Option<String>,
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
    use super::{
        CertificateFacts, CertificateOutcome, CertificatePaths, ChallengeStore, LetsEncryptConfig,
    };
    use anyhow::{bail, Context, Result};
    use instant_acme::{
        Account, AccountBuilder, AccountCredentials, AuthorizationStatus, ChallengeType,
        Identifier, LetsEncrypt, NewAccount, NewOrder, OrderStatus, RetryPolicy,
    };
    use openssl::asn1::Asn1Time;
    use openssl::pkey::PKey;
    use openssl::x509::X509;
    use std::cmp::Ordering;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const ACME_DIR_ENV: &str = "RATHOLE_ACME_DIR";
    const RENEW_BEFORE_DAYS: u32 = 30;

    pub(crate) struct AcmeIssuer {
        challenges: Arc<ChallengeStore>,
        storage_dir: PathBuf,
    }

    impl AcmeIssuer {
        pub(crate) fn new(challenges: Arc<ChallengeStore>) -> Self {
            Self::with_storage_dir(challenges, default_storage_dir())
        }

        /// Same, with an explicit store. `default_storage_dir` reads process-wide
        /// environment, which tests running in parallel cannot safely share.
        pub(crate) fn with_storage_dir(
            challenges: Arc<ChallengeStore>,
            storage_dir: PathBuf,
        ) -> Self {
            Self {
                challenges,
                storage_dir,
            }
        }

        /// Make sure a certificate covering `domains` is on disk, issuing one if
        /// what is there is missing, stale, or covers a different SAN set.
        ///
        /// Only errors when the request itself is unusable (bad domains, unwritable
        /// store). A failed *issuance* comes back as `outcome.error`, keeping any
        /// existing certificate in `outcome.paths` so a renewal failure degrades to
        /// "serving the old certificate" rather than dropping TLS entirely.
        pub(crate) async fn ensure_certificate(
            &self,
            config: &LetsEncryptConfig,
            domains: &[String],
        ) -> Result<CertificateOutcome> {
            let domains = normalize_domains(domains)?;
            let environment_dir = self.storage_dir.join(environment_name(config.staging));
            let cert_dir = environment_dir.join(sanitize_path_part(&domains[0]));
            let paths = CertificatePaths {
                cert_path: cert_dir.join("fullchain.pem"),
                key_path: cert_dir.join("key.pem"),
            };
            let domains_path = cert_dir.join("domains.txt");

            let facts = inspect_certificate(&paths, &domains_path, &domains)?;
            if facts.fresh {
                return Ok(CertificateOutcome {
                    paths: Some(paths),
                    facts,
                    renewed: false,
                    error: None,
                });
            }
            // Parseable means there is something we could still serve if issuance
            // fails below.
            let existing = facts.not_after_ms.map(|_| paths.clone());

            fs::create_dir_all(&cert_dir).with_context(|| {
                format!("creating ACME certificate directory {}", cert_dir.display())
            })?;
            fs::create_dir_all(&environment_dir).with_context(|| {
                format!(
                    "creating ACME account directory {}",
                    environment_dir.display()
                )
            })?;

            tracing::info!(
                domains = ?domains,
                staging = config.staging,
                reason = facts.reason.unwrap_or("renewal"),
                "requesting Let's Encrypt certificate"
            );
            let issued = async {
                let account = load_or_create_account(config, &environment_dir).await?;
                self.issue_certificate(&account, &domains).await
            }
            .await;

            let (certificate_pem, private_key_pem) = match issued {
                Ok(pair) => pair,
                Err(error) => {
                    return Ok(CertificateOutcome {
                        paths: existing,
                        facts,
                        renewed: false,
                        error: Some(format!("{error:#}")),
                    });
                }
            };

            // Key first, then the certificate, then the SAN marker last: the pair
            // is still two renames, but this order means a crash in the middle
            // leaves a mismatch that `inspect_certificate` detects and re-issues,
            // rather than a marker claiming a pair that was never completed.
            write_secret_atomic(&paths.key_path, private_key_pem.as_bytes())
                .with_context(|| format!("writing {}", paths.key_path.display()))?;
            write_atomic(&paths.cert_path, certificate_pem.as_bytes())
                .with_context(|| format!("writing {}", paths.cert_path.display()))?;
            write_atomic(&domains_path, domains.join("\n").as_bytes())
                .with_context(|| format!("writing {}", domains_path.display()))?;

            // Re-read what we just wrote so the reported expiry describes the real
            // certificate. If this says "not fresh" we would re-issue on every
            // check and burn the duplicate-certificate limit, so treat it as fatal
            // rather than looping.
            let facts = inspect_certificate(&paths, &domains_path, &domains)?;
            if !facts.fresh {
                bail!(
                    "just-issued certificate still looks stale ({}); refusing to re-issue in a loop",
                    facts.reason.unwrap_or("unknown reason")
                );
            }

            tracing::info!(
                domains = ?domains,
                staging = config.staging,
                "issued Let's Encrypt certificate"
            );
            Ok(CertificateOutcome {
                paths: Some(paths),
                facts,
                renewed: true,
                error: None,
            })
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
                    let key_authorization = challenge.key_authorization().as_str().to_string();
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

    fn account_builder() -> Result<AccountBuilder> {
        Account::builder().context("building ACME account client")
    }

    /// Look at the certificate on disk: is it usable, and when does it expire?
    ///
    /// Parses before comparing SAN sets so the expiry is still reported for a
    /// certificate that is merely superseded.
    pub(crate) fn inspect_certificate(
        paths: &CertificatePaths,
        domains_path: &Path,
        domains: &[String],
    ) -> Result<CertificateFacts> {
        fn not_fresh(
            reason: &'static str,
            not_after_ms: Option<u64>,
            covered_domains: Option<Vec<String>>,
        ) -> CertificateFacts {
            CertificateFacts {
                fresh: false,
                not_after_ms,
                covered_domains,
                reason: Some(reason),
            }
        }

        if !paths.cert_path.exists() || !paths.key_path.exists() {
            return Ok(not_fresh("missing", None, None));
        }

        let cert_pem = match fs::read(&paths.cert_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(path = %paths.cert_path.display(), ?error, "failed to read existing ACME certificate");
                return Ok(not_fresh("unreadable", None, None));
            }
        };
        let cert = match X509::from_pem(&cert_pem) {
            Ok(cert) => cert,
            Err(error) => {
                tracing::warn!(path = %paths.cert_path.display(), ?error, "failed to parse existing ACME certificate");
                return Ok(not_fresh("unparseable", None, None));
            }
        };
        let not_after_ms = Some(not_after_epoch_ms(&cert)?);
        let covered = read_domains(domains_path);

        // The certificate and key are two separate files, so a crash or a
        // concurrent issuance can leave them from different orders. Serving a
        // mismatched pair makes Pingora fail to start, so detect it here and
        // treat it as a reason to re-issue.
        if !key_matches_certificate(&cert, &paths.key_path) {
            return Ok(not_fresh("mismatched-key", not_after_ms, covered));
        }

        if covered.as_deref() != Some(domains) {
            return Ok(not_fresh("domains-changed", not_after_ms, covered));
        }

        let threshold = Asn1Time::days_from_now(RENEW_BEFORE_DAYS)
            .context("computing certificate renewal threshold")?;
        let fresh = cert
            .not_after()
            .compare(&threshold)
            .context("checking ACME certificate expiry")?
            == Ordering::Greater;
        if !fresh {
            return Ok(not_fresh("expiring", not_after_ms, covered));
        }
        Ok(CertificateFacts {
            fresh: true,
            not_after_ms,
            covered_domains: covered,
            reason: None,
        })
    }

    /// Whether the private key on disk belongs to this certificate.
    fn key_matches_certificate(cert: &X509, key_path: &Path) -> bool {
        let Ok(key_pem) = fs::read(key_path) else {
            tracing::warn!(path = %key_path.display(), "failed to read existing ACME key");
            return false;
        };
        let Ok(key) = PKey::private_key_from_pem(&key_pem) else {
            tracing::warn!(path = %key_path.display(), "failed to parse existing ACME key");
            return false;
        };
        match cert.public_key() {
            Ok(cert_key) => cert_key.public_eq(&key),
            Err(error) => {
                tracing::warn!(?error, "failed to read the certificate's public key");
                false
            }
        }
    }

    /// Absolute expiry as epoch ms, derived by diffing against now rather than
    /// string-parsing the ASN.1 time.
    fn not_after_epoch_ms(cert: &X509) -> Result<u64> {
        let now = Asn1Time::days_from_now(0).context("reading the current time")?;
        // `a.diff(b)` measures a -> b, so this is positive while the cert is valid.
        let diff = now
            .diff(cert.not_after())
            .context("measuring ACME certificate lifetime")?;
        let delta_secs = diff.days as i64 * 86_400 + diff.secs as i64;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("reading the system clock")?
            .as_millis() as u64;
        Ok(if delta_secs >= 0 {
            now_ms.saturating_add(delta_secs as u64 * 1_000)
        } else {
            now_ms.saturating_sub(delta_secs.unsigned_abs() * 1_000)
        })
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
        // Unique per write: a fixed name lets two concurrent issuances clobber
        // each other's temp file and land a certificate and key from different
        // orders, which Pingora then refuses to load.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let tmp = path.with_extension(format!("tmp.{}.{nanos}", std::process::id()));
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

    #[cfg(test)]
    mod tests {
        use super::*;
        use openssl::hash::MessageDigest;
        use openssl::pkey::PKey;
        use openssl::rsa::Rsa;
        use openssl::x509::{X509Builder, X509NameBuilder};

        /// Write a self-signed certificate expiring `days` from now, plus a key
        /// and the SAN-set marker file, into a fresh directory.
        fn write_cert(dir: &Path, domains: &[&str], days: i64) -> CertificatePaths {
            let rsa = Rsa::generate(2048).expect("rsa");
            let key = PKey::from_rsa(rsa).expect("pkey");

            let mut name = X509NameBuilder::new().expect("name builder");
            name.append_entry_by_text("CN", domains[0]).expect("cn");
            let name = name.build();

            let mut builder = X509Builder::new().expect("x509 builder");
            builder.set_version(2).expect("version");
            builder.set_subject_name(&name).expect("subject");
            builder.set_issuer_name(&name).expect("issuer");
            builder.set_pubkey(&key).expect("pubkey");
            builder
                .set_not_before(&Asn1Time::days_from_now(0).expect("not_before"))
                .expect("set not_before");
            let not_after = if days >= 0 {
                Asn1Time::days_from_now(days as u32).expect("not_after")
            } else {
                let past = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_secs() as i64
                    + days * 86_400;
                Asn1Time::from_unix(past).expect("past not_after")
            };
            builder.set_not_after(&not_after).expect("set not_after");
            builder.sign(&key, MessageDigest::sha256()).expect("sign");
            let cert = builder.build();

            fs::create_dir_all(dir).expect("mkdir");
            let paths = CertificatePaths {
                cert_path: dir.join("fullchain.pem"),
                key_path: dir.join("key.pem"),
            };
            fs::write(&paths.cert_path, cert.to_pem().expect("cert pem")).expect("write cert");
            fs::write(
                &paths.key_path,
                key.private_key_to_pem_pkcs8().expect("key pem"),
            )
            .expect("write key");
            fs::write(dir.join("domains.txt"), domains.join("\n")).expect("write domains");
            paths
        }

        fn scratch(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("rathole-acme-test-{name}"));
            let _ = fs::remove_dir_all(&dir);
            dir
        }

        fn owned(domains: &[&str]) -> Vec<String> {
            domains.iter().map(|d| d.to_string()).collect()
        }

        #[test]
        fn a_long_lived_certificate_is_fresh() {
            let dir = scratch("fresh");
            let paths = write_cert(&dir, &["app.example.com"], 60);
            let facts = inspect_certificate(
                &paths,
                &dir.join("domains.txt"),
                &owned(&["app.example.com"]),
            )
            .expect("inspect");

            assert!(facts.fresh);
            assert!(facts.reason.is_none());
            assert_eq!(
                facts.covered_domains.as_deref(),
                Some(&["app.example.com".to_string()][..])
            );
            let not_after = facts.not_after_ms.expect("expiry");
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let days_left = (not_after - now_ms) / 86_400_000;
            assert!((59..=60).contains(&days_left), "days_left = {days_left}");
        }

        #[test]
        fn a_certificate_inside_the_renewal_window_is_not_fresh() {
            let dir = scratch("expiring");
            let paths = write_cert(&dir, &["app.example.com"], 10);
            let facts = inspect_certificate(
                &paths,
                &dir.join("domains.txt"),
                &owned(&["app.example.com"]),
            )
            .expect("inspect");

            assert!(!facts.fresh);
            assert_eq!(facts.reason, Some("expiring"));
            // Still reported, so the panel can show the countdown.
            assert!(facts.not_after_ms.is_some());
        }

        #[test]
        fn an_expired_certificate_still_reports_its_expiry() {
            let dir = scratch("expired");
            let paths = write_cert(&dir, &["app.example.com"], -5);
            let facts = inspect_certificate(
                &paths,
                &dir.join("domains.txt"),
                &owned(&["app.example.com"]),
            )
            .expect("inspect");

            assert!(!facts.fresh);
            let not_after = facts.not_after_ms.expect("expiry");
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            assert!(not_after < now_ms, "expiry should be in the past");
        }

        #[test]
        fn adding_a_host_supersedes_the_certificate_but_keeps_its_expiry() {
            let dir = scratch("domains-changed");
            let paths = write_cert(&dir, &["app.example.com"], 60);
            let facts = inspect_certificate(
                &paths,
                &dir.join("domains.txt"),
                &owned(&["api.example.com", "app.example.com"]),
            )
            .expect("inspect");

            assert!(!facts.fresh);
            assert_eq!(facts.reason, Some("domains-changed"));
            assert!(facts.not_after_ms.is_some());
            // The old SAN set, not the newly requested one — this is what the
            // panel must show while a re-issue is outstanding.
            assert_eq!(
                facts.covered_domains.as_deref(),
                Some(&["app.example.com".to_string()][..])
            );
        }

        #[test]
        fn a_certificate_whose_key_does_not_match_is_not_fresh() {
            let dir = scratch("mismatched-key");
            let paths = write_cert(&dir, &["app.example.com"], 60);
            // Simulate two interleaved issuances landing a cert and key from
            // different orders.
            let stray = PKey::from_rsa(Rsa::generate(2048).expect("rsa")).expect("pkey");
            fs::write(
                &paths.key_path,
                stray.private_key_to_pem_pkcs8().expect("key pem"),
            )
            .expect("clobber key");

            let facts = inspect_certificate(
                &paths,
                &dir.join("domains.txt"),
                &owned(&["app.example.com"]),
            )
            .expect("inspect");

            assert!(!facts.fresh);
            assert_eq!(facts.reason, Some("mismatched-key"));
        }

        #[test]
        fn a_missing_certificate_reports_missing() {
            let dir = scratch("missing");
            fs::create_dir_all(&dir).expect("mkdir");
            let paths = CertificatePaths {
                cert_path: dir.join("fullchain.pem"),
                key_path: dir.join("key.pem"),
            };
            let facts = inspect_certificate(
                &paths,
                &dir.join("domains.txt"),
                &owned(&["app.example.com"]),
            )
            .expect("inspect");

            assert!(!facts.fresh);
            assert_eq!(facts.reason, Some("missing"));
            assert!(facts.not_after_ms.is_none());
        }

        #[test]
        fn a_corrupt_certificate_reports_unparseable() {
            let dir = scratch("garbage");
            let paths = write_cert(&dir, &["app.example.com"], 60);
            fs::write(&paths.cert_path, b"not a certificate").expect("clobber");
            let facts = inspect_certificate(
                &paths,
                &dir.join("domains.txt"),
                &owned(&["app.example.com"]),
            )
            .expect("inspect");

            assert!(!facts.fresh);
            assert_eq!(facts.reason, Some("unparseable"));
            assert!(facts.not_after_ms.is_none());
        }

        #[test]
        fn wildcards_and_empty_host_sets_are_rejected() {
            assert!(normalize_domains(&owned(&["*.example.com"])).is_err());
            assert!(normalize_domains(&[]).is_err());
            assert!(normalize_domains(&owned(&["   "])).is_err());
        }

        #[test]
        fn domains_are_lowercased_sorted_and_deduped() {
            let normalized = normalize_domains(&owned(&[
                "B.example.com.",
                "a.example.com",
                "A.example.com",
            ]))
            .expect("normalize");
            assert_eq!(normalized, vec!["a.example.com", "b.example.com"]);
        }

        #[test]
        fn path_parts_cannot_escape_the_store() {
            // Separators become underscores, then leading dots are trimmed.
            assert_eq!(sanitize_path_part("../../etc/passwd"), "_.._etc_passwd");
            assert_eq!(sanitize_path_part("app.example.com"), "app.example.com");
            assert_eq!(sanitize_path_part("..."), "default");
        }
    }
}

#[cfg(unix)]
pub(crate) use imp::AcmeIssuer;
