//! A small terminal UI for `rathole-agent login`: collects the panel URL,
//! username and password, and drives login + enrollment with live status.

use std::io::{self, Stdout};

use anyhow::{Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::{Frame, Terminal};

use crate::enroll::{self, Identity};

type Term = Terminal<CrosstermBackend<Stdout>>;

#[derive(PartialEq)]
enum Phase {
    Editing,
    Submitting,
    Done,
}

struct App {
    fields: [String; 3], // hub_url, username, password
    name: String,
    active: usize,
    phase: Phase,
    status: Option<(String, bool)>, // (message, is_error)
    result: Option<Identity>,
}

const LABELS: [&str; 3] = ["Panel URL", "Username", "Password"];

impl App {
    fn new() -> Self {
        let hub_url = std::env::var("HUB_URL").unwrap_or_default();
        let name = std::env::var("INSTANCE_NAME")
            .ok()
            .or_else(enroll_hostname)
            .unwrap_or_else(|| "rathole-node".to_string());
        App {
            fields: [hub_url, String::new(), String::new()],
            name,
            active: 0,
            phase: Phase::Editing,
            status: None,
            result: None,
        }
    }

    fn ready(&self) -> bool {
        self.fields.iter().all(|f| !f.trim().is_empty())
    }
}

fn enroll_hostname() -> Option<String> {
    crate::sysstat::hostname()
}

/// Run the login TUI. Returns the enrolled identity, or `None` if the user
/// cancelled with Esc / Ctrl-C.
pub fn run_login() -> Result<Option<Identity>> {
    let mut terminal = setup_terminal()?;
    let outcome = event_loop(&mut terminal);
    restore_terminal(&mut terminal)?;
    outcome
}

fn setup_terminal() -> Result<Term> {
    enable_raw_mode().context("enabling raw mode (is this a real terminal?)")?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    Terminal::new(CrosstermBackend::new(stdout)).context("creating terminal")
}

fn restore_terminal(terminal: &mut Term) -> Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}

fn event_loop(terminal: &mut Term) -> Result<Option<Identity>> {
    let mut app = App::new();
    loop {
        terminal.draw(|f| draw(f, &app))?;

        if app.phase == Phase::Submitting {
            // Perform login + enrollment (blocking). Redraw already showed status.
            let node = enroll::node_id();
            match enroll::login_and_enroll(
                app.fields[0].trim(),
                app.fields[1].trim(),
                &app.fields[2],
                &node,
                app.name.trim(),
            ) {
                Ok(identity) => {
                    app.result = Some(identity);
                    app.phase = Phase::Done;
                    app.status = Some(("Enrolled successfully.".into(), false));
                }
                Err(e) => {
                    app.phase = Phase::Editing;
                    app.status = Some((format!("{e:#}"), true));
                }
            }
            continue;
        }

        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }

        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Ok(None);
        }

        if app.phase == Phase::Done {
            // Any key closes once finished.
            return Ok(app.result.take());
        }

        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Tab | KeyCode::Down => app.active = (app.active + 1) % 3,
            KeyCode::BackTab | KeyCode::Up => app.active = (app.active + 2) % 3,
            KeyCode::Enter => {
                if app.active < 2 {
                    app.active += 1;
                } else if app.ready() {
                    app.phase = Phase::Submitting;
                    app.status = Some(("Logging in and enrolling…".into(), false));
                } else {
                    app.status = Some(("Fill in every field first.".into(), true));
                }
            }
            KeyCode::Backspace => {
                app.fields[app.active].pop();
            }
            KeyCode::Char(c) => app.fields[app.active].push(c),
            _ => {}
        }
    }
}

fn draw(f: &mut Frame, app: &App) {
    let areas = Layout::vertical([
        Constraint::Length(2), // title
        Constraint::Length(3), // hub url
        Constraint::Length(3), // username
        Constraint::Length(3), // password
        Constraint::Length(2), // name line
        Constraint::Length(2), // status
        Constraint::Min(1),    // help
    ])
    .split(f.area());

    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                "rathole-agent",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  ·  enroll this node with your panel account"),
        ])),
        areas[0],
    );

    for i in 0..3 {
        let is_active = app.active == i && app.phase != Phase::Done;
        let shown = if i == 2 {
            "•".repeat(app.fields[i].chars().count())
        } else {
            app.fields[i].clone()
        };
        let border = if is_active {
            Style::default().fg(Color::Cyan)
        } else {
            Style::default().fg(Color::DarkGray)
        };
        let cursor = if is_active { "▏" } else { "" };
        f.render_widget(
            Paragraph::new(format!("{shown}{cursor}")).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(border)
                    .title(format!(" {} ", LABELS[i])),
            ),
            areas[1 + i],
        );
    }

    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("Instance name: ", Style::default().fg(Color::DarkGray)),
            Span::raw(&app.name),
        ])),
        areas[4],
    );

    if let Some((msg, is_error)) = &app.status {
        let color = if *is_error { Color::Red } else { Color::Green };
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                msg.clone(),
                Style::default().fg(color),
            ))),
            areas[5],
        );
    }

    let help = if app.phase == Phase::Done {
        "Press any key to exit."
    } else {
        "Tab/↑↓ move · Enter next/submit · Esc cancel"
    };
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            help,
            Style::default().fg(Color::DarkGray),
        ))),
        areas[6],
    );
}
