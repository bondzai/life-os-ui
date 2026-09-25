//! The capture grammar, ported from the web app so the phone and the browser speak one language.
//!
//! `src/core/config/capture-protocol.ts` has been the app's grammar since long before there was a
//! Rust server: `!` is a task, `@` is a goal, `/bug` is a high-priority task tagged `bug`. Typing
//! the same line into Telegram and into ⌘K must mean the same thing, or you end up holding two
//! grammars in your head and using neither well.
//!
//! So this is a **port, not a design**. Where a rule here looks arbitrary it is because the
//! TypeScript says so, and [`tests::the_rust_table_agrees_with_the_typescript`] reads that file at
//! test time and fails if the two drift. That test is the entire reason this module can be trusted:
//! a hand-copied table is a table that is wrong six months from now.
//!
//! # It parses. It does not write.
//!
//! Nothing here touches the database. The parse is echoed back so the grammar can be judged before
//! it is given the power to change anything — which is also the cheapest possible way to find out
//! that `friday` means the wrong Friday.
//!
//! # Two things `@` means
//!
//! `@` is the goal prefix *and* the project reference, which is a real collision inherited from the
//! TypeScript. It is resolved by position, which is how you already read it without noticing:
//!
//! - `@ Ship v1 by Q2` — `@` in the **first** position is the goal prefix.
//! - `!call the accountant @Accounts` — `@word` **anywhere else** names a project.
//!
//! A line cannot sensibly be both "create a goal" and "file this under a goal", so position is
//! enough, and it costs no new syntax.

use chrono::{Datelike, Duration, NaiveDate, Weekday};

/// One capture rule: what a prefix or command means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    /// The `!`/`@` prefix, or the `/command`.
    pub token: &'static str,
    pub label: &'static str,
    pub entity_type: &'static str,
    pub priority: &'static str,
    pub tags: &'static [&'static str],
}

/// The single-character prefixes, in the TypeScript's order.
pub const PREFIXES: &[Rule] = &[
    Rule {
        token: "!",
        label: "Task",
        entity_type: "task",
        priority: "medium",
        tags: &[],
    },
    Rule {
        token: "?",
        label: "Question",
        entity_type: "note",
        priority: "medium",
        tags: &["question"],
    },
    Rule {
        token: "*",
        label: "Idea",
        entity_type: "note",
        priority: "medium",
        tags: &["idea"],
    },
    Rule {
        token: "@",
        label: "Goal",
        entity_type: "goal",
        priority: "medium",
        tags: &[],
    },
    Rule {
        token: "#",
        label: "Habit",
        entity_type: "habit",
        priority: "medium",
        tags: &[],
    },
];

/// A slash command and the short forms that mean the same thing.
#[derive(Debug, Clone, Copy)]
pub struct Command {
    pub rule: Rule,
    pub aliases: &'static [&'static str],
}

/// The slash commands, in the TypeScript's order.
pub const COMMANDS: &[Command] = &[
    Command {
        aliases: &["/t"],
        rule: Rule {
            token: "/task",
            label: "Task",
            entity_type: "task",
            priority: "medium",
            tags: &[],
        },
    },
    Command {
        aliases: &["/n"],
        rule: Rule {
            token: "/note",
            label: "Note",
            entity_type: "note",
            priority: "medium",
            tags: &[],
        },
    },
    Command {
        aliases: &[],
        rule: Rule {
            token: "/bug",
            label: "Bug",
            entity_type: "task",
            priority: "high",
            tags: &["bug"],
        },
    },
    Command {
        aliases: &["/q"],
        rule: Rule {
            token: "/question",
            label: "Question",
            entity_type: "note",
            priority: "medium",
            tags: &["question"],
        },
    },
    Command {
        aliases: &["/mtg"],
        rule: Rule {
            token: "/meeting",
            label: "Meeting",
            entity_type: "note",
            priority: "medium",
            tags: &["meeting"],
        },
    },
    Command {
        aliases: &["/url"],
        rule: Rule {
            token: "/link",
            label: "Link",
            entity_type: "note",
            priority: "medium",
            tags: &["link"],
        },
    },
    Command {
        aliases: &["/code"],
        rule: Rule {
            token: "/snippet",
            label: "Snippet",
            entity_type: "note",
            priority: "medium",
            tags: &["snippet"],
        },
    },
    Command {
        aliases: &["/ev"],
        rule: Rule {
            token: "/event",
            label: "Event",
            entity_type: "event",
            priority: "medium",
            tags: &[],
        },
    },
    Command {
        aliases: &["/bm"],
        rule: Rule {
            token: "/bookmark",
            label: "Bookmark",
            entity_type: "note",
            priority: "low",
            tags: &["bookmark"],
        },
    },
    Command {
        aliases: &["/i"],
        rule: Rule {
            token: "/idea",
            label: "Idea",
            entity_type: "note",
            priority: "medium",
            tags: &["idea"],
        },
    },
    Command {
        aliases: &["/g"],
        rule: Rule {
            token: "/goal",
            label: "Goal",
            entity_type: "goal",
            priority: "medium",
            tags: &[],
        },
    },
    Command {
        aliases: &["/h"],
        rule: Rule {
            token: "/habit",
            label: "Habit",
            entity_type: "habit",
            priority: "medium",
            tags: &[],
        },
    },
    Command {
        aliases: &[],
        rule: Rule {
            token: "/someday",
            label: "Someday",
            entity_type: "task",
            priority: "low",
            tags: &["someday"],
        },
    },
    Command {
        aliases: &["/d"],
        rule: Rule {
            token: "/decide",
            label: "Decision",
            entity_type: "note",
            priority: "high",
            tags: &["decision"],
        },
    },
    Command {
        aliases: &["/block"],
        rule: Rule {
            token: "/blocker",
            label: "Blocker",
            entity_type: "task",
            priority: "urgent",
            tags: &["blocker"],
        },
    },
    Command {
        aliases: &[],
        rule: Rule {
            token: "/spark",
            label: "Spark",
            entity_type: "note",
            priority: "medium",
            tags: &["spark"],
        },
    },
    Command {
        aliases: &[],
        rule: Rule {
            token: "/think",
            label: "Think",
            entity_type: "note",
            priority: "medium",
            tags: &["think"],
        },
    },
    Command {
        aliases: &[],
        rule: Rule {
            token: "/rant",
            label: "Rant",
            entity_type: "note",
            priority: "low",
            tags: &["rant"],
        },
    },
    Command {
        aliases: &["/ann"],
        rule: Rule {
            token: "/announce",
            label: "Announce",
            entity_type: "note",
            priority: "medium",
            tags: &["announce"],
        },
    },
    Command {
        aliases: &["/exp"],
        rule: Rule {
            token: "/experiment",
            label: "Experiment",
            entity_type: "note",
            priority: "medium",
            tags: &["experiment"],
        },
    },
];

/// No prefix at all. The TypeScript's `NOTE_RULE`.
pub const NOTE: Rule = Rule {
    token: "",
    label: "Note",
    entity_type: "note",
    priority: "medium",
    tags: &[],
};

/// What one line of capture text turned out to mean.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub rule: Rule,
    /// The text with the command, the date phrase and the `@project` removed — what the thing
    /// would actually be called.
    pub title: String,
    /// `YYYY-MM-DD`, when a date phrase was recognised.
    pub due: Option<String>,
    /// The phrase that produced `due`, so the echo can show what it understood rather than only
    /// the answer. "friday → 2026-09-25" is checkable; "2026-09-25" alone is not.
    pub due_phrase: Option<String>,
    /// The `@name` reference, unresolved. Resolving it against real projects needs the database,
    /// which this module deliberately does not have.
    pub project: Option<String>,
}

/// Match a slash command, longest token first so `/block` cannot be shadowed by a shorter prefix.
fn match_command(lower: &str) -> Option<(Rule, usize)> {
    let mut best: Option<(Rule, usize)> = None;
    for command in COMMANDS {
        for token in std::iter::once(&command.rule.token).chain(command.aliases) {
            let hit = lower == *token || lower.starts_with(&format!("{token} "));
            if hit && best.is_none_or(|(_, len)| token.len() > len) {
                best = Some((command.rule, token.len()));
            }
        }
    }
    best
}

/// Parse one line.
///
/// Order matters and matches the TypeScript exactly: slash commands, then single-character
/// prefixes, then "it is a note". A `/` line that matches no command falls through to a note rather
/// than erroring — the same as the web app, where an unknown slash is just text.
pub fn parse(raw: &str, today: NaiveDate) -> Parsed {
    let text = raw.trim();
    if text.is_empty() {
        return Parsed {
            rule: NOTE,
            title: String::new(),
            due: None,
            due_phrase: None,
            project: None,
        };
    }

    let lower = text.to_lowercase();
    let (rule, rest) = match match_command(&lower) {
        Some((rule, len)) => (rule, text[len..].trim()),
        None => match PREFIXES.iter().find(|r| text.starts_with(r.token)) {
            // The goal prefix is the `@` in *first* position; see the module docs.
            Some(rule) => (*rule, text[rule.token.len()..].trim()),
            None => (NOTE, text),
        },
    };

    let (rest, project) = take_project(rest);
    let (title, due, due_phrase) = take_date(&rest, today);

    Parsed {
        rule,
        title,
        due,
        due_phrase,
        project,
    }
}

/// Pull an `@name` out of the middle of a line.
///
/// Only the first is taken. A line with two project references is ambiguous, and picking one
/// silently is worse than ignoring the second — the echo shows which one was used.
fn take_project(text: &str) -> (String, Option<String>) {
    let mut project = None;
    let kept: Vec<&str> = text
        .split_whitespace()
        .filter(|word| {
            if project.is_none() && word.len() > 1 && word.starts_with('@') {
                project = Some(
                    word[1..]
                        .trim_matches(|c: char| !c.is_alphanumeric())
                        .to_string(),
                );
                return false;
            }
            true
        })
        .collect();
    (kept.join(" "), project.filter(|p| !p.is_empty()))
}

/// Date phrases, longest first so `next friday` is not eaten by `friday`.
const PHRASES: &[&str] = &[
    "the day after tomorrow",
    "next monday",
    "next tuesday",
    "next wednesday",
    "next thursday",
    "next friday",
    "next saturday",
    "next sunday",
    "next week",
    "tomorrow",
    "today",
    "tonight",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

/// Pull a trailing date phrase off the end of a line.
///
/// **Trailing only, and that is deliberate.** "call Monday about the invoice" is not due on Monday,
/// and a parser that searches the whole line for a weekday would say it was. People put the when at
/// the end — `call the accountant tomorrow` — so that is the only place this looks.
fn take_date(text: &str, today: NaiveDate) -> (String, Option<String>, Option<String>) {
    let lower = text.to_lowercase();

    // `in N days` is a shape rather than a word, so it is matched separately.
    if let Some((title, days, phrase)) = trailing_in_n_days(text, &lower) {
        return (title, Some(iso(today + Duration::days(days))), Some(phrase));
    }

    for phrase in PHRASES {
        // `strip_suffix` on the lowered copy, then cut the original at the same byte offset, so the
        // title keeps its original casing.
        if let Some(head) = lower.strip_suffix(phrase) {
            if !head.is_empty() && !head.ends_with(' ') {
                // `...onfriday` — a suffix match inside a word, not a date.
                continue;
            }
            let date = resolve_phrase(phrase, today);
            return (
                text[..head.len()].trim_end().to_string(),
                Some(iso(date)),
                Some((*phrase).to_string()),
            );
        }
    }
    (text.to_string(), None, None)
}

fn trailing_in_n_days(text: &str, lower: &str) -> Option<(String, i64, String)> {
    let words: Vec<&str> = lower.split_whitespace().collect();
    // "… in 3 days"
    let [.., "in", number, unit] = words.as_slice() else {
        return None;
    };
    if *unit != "days" && *unit != "day" {
        return None;
    }
    let days: i64 = number.parse().ok()?;
    let phrase = format!("in {number} {unit}");
    let cut = lower.rfind(&phrase)?;
    Some((text[..cut].trim_end().to_string(), days, phrase))
}

fn resolve_phrase(phrase: &str, today: NaiveDate) -> NaiveDate {
    match phrase {
        "today" | "tonight" => today,
        "tomorrow" => today + Duration::days(1),
        "the day after tomorrow" => today + Duration::days(2),
        "next week" => today + Duration::days(7),
        other => {
            let (name, next) = match other.strip_prefix("next ") {
                Some(name) => (name, true),
                None => (other, false),
            };
            let Some(target) = weekday(name) else {
                return today;
            };
            // The *coming* one. "friday" on a Friday means next Friday, not today: someone typing
            // a weekday is naming a day they are not currently in the middle of.
            let ahead = (target.num_days_from_monday() as i64
                - today.weekday().num_days_from_monday() as i64)
                .rem_euclid(7);
            let ahead = if ahead == 0 { 7 } else { ahead };
            today + Duration::days(if next { ahead + 7 } else { ahead })
        }
    }
}

fn weekday(name: &str) -> Option<Weekday> {
    Some(match name {
        "monday" => Weekday::Mon,
        "tuesday" => Weekday::Tue,
        "wednesday" => Weekday::Wed,
        "thursday" => Weekday::Thu,
        "friday" => Weekday::Fri,
        "saturday" => Weekday::Sat,
        "sunday" => Weekday::Sun,
        _ => return None,
    })
}

fn iso(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// The parse, written out for a human to check.
///
/// This is the whole deliverable of the echo-only stage: it must make a wrong parse **obvious**.
/// So it names the phrase as well as the date it resolved to, and says plainly that nothing was
/// saved — a reply that looks like a confirmation, for an action that did not happen, is worse
/// than no reply.
pub fn echo(parsed: &Parsed) -> String {
    let mut out = format!(
        "{}: {}\n",
        parsed.rule.label,
        if parsed.title.is_empty() {
            "(no title)"
        } else {
            &parsed.title
        }
    );

    if let (Some(due), Some(phrase)) = (&parsed.due, &parsed.due_phrase) {
        out.push_str(&format!("due: {due}  (from \"{phrase}\")\n"));
    }
    if let Some(project) = &parsed.project {
        out.push_str(&format!(
            "project: @{project}  (not yet matched to a real project)\n"
        ));
    }
    if !parsed.rule.tags.is_empty() {
        out.push_str(&format!("tags: {}\n", parsed.rule.tags.join(", ")));
    }
    if parsed.rule.priority != "medium" {
        out.push_str(&format!("priority: {}\n", parsed.rule.priority));
    }

    out.push_str("\nNothing was saved — I can read this but not write it yet.");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Monday, so weekday arithmetic is checkable by hand.
    fn monday() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 21).unwrap()
    }

    // ---------- the port is a port ----------

    /// Read `capture-protocol.ts` and assert this file agrees with it.
    ///
    /// The reason this module can be trusted. A hand-copied table is a table that is wrong six
    /// months from now, and the failure is silent: `/bug` quietly stops being high priority on the
    /// phone while staying high in the browser, and nobody notices until it matters.
    #[test]
    fn the_rust_table_agrees_with_the_typescript() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/core/config/capture-protocol.ts"
        );
        let source = std::fs::read_to_string(path).unwrap_or_else(|e| {
            panic!("the grammar's source of truth must be readable: {path}: {e}")
        });

        // One regex over the literal table, rather than a TypeScript parser: the table is one entry
        // per line by convention, and a reformat that breaks this test is a reformat worth seeing.
        let entry = regex::Regex::new(
            r"\{ command: '(?<command>[^']+)', *aliases: \[(?<aliases>[^\]]*)\].*?entityType: '(?<kind>[a-z]+)', *defaultPriority: '(?<priority>[a-z]+)', *autoTags: \[(?<tags>[^\]]*)\]",
        )
        .unwrap();

        let mut seen = 0;
        for caps in entry.captures_iter(&source) {
            seen += 1;
            let command = caps.name("command").unwrap().as_str();
            let ours = COMMANDS
                .iter()
                .find(|c| c.rule.token == command)
                .unwrap_or_else(|| panic!("{command} exists in the TypeScript and not here"));

            assert_eq!(
                ours.rule.entity_type,
                caps.name("kind").unwrap().as_str(),
                "{command}: type"
            );
            assert_eq!(
                ours.rule.priority,
                caps.name("priority").unwrap().as_str(),
                "{command}: priority"
            );

            let quoted = |raw: &str| -> Vec<String> {
                raw.split(',')
                    .map(|s| s.trim().trim_matches('\'').to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            };
            assert_eq!(
                quoted(caps.name("aliases").unwrap().as_str()),
                ours.aliases,
                "{command}: aliases"
            );
            assert_eq!(
                quoted(caps.name("tags").unwrap().as_str()),
                ours.rule.tags,
                "{command}: tags"
            );
        }

        assert!(
            seen >= 20,
            "only matched {seen} commands — has the table been reformatted?"
        );
        assert_eq!(seen, COMMANDS.len(), "the two tables are different lengths");
    }

    #[test]
    fn the_prefixes_agree_with_the_typescript() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/core/config/capture-protocol.ts"
        );
        let source = std::fs::read_to_string(path).unwrap();
        for (name, token) in [
            ("Task", "!"),
            ("Question", "?"),
            ("Idea", "*"),
            ("Goal", "@"),
            ("Habit", "#"),
        ] {
            assert!(
                source.contains(&format!("{name}: '{token}'")),
                "the TypeScript no longer maps {name} to {token}"
            );
            assert!(
                PREFIXES.iter().any(|r| r.token == token && r.label == name),
                "{name}/{token} is missing here"
            );
        }
    }

    // ---------- prefixes and commands ----------

    #[test]
    fn a_bare_line_is_a_note() {
        let parsed = parse("think about the roadmap", monday());
        assert_eq!(parsed.rule.label, "Note");
        assert_eq!(parsed.title, "think about the roadmap");
        assert_eq!(parsed.due, None);
    }

    #[test]
    fn a_prefix_sets_the_type_and_is_stripped() {
        let parsed = parse("!buy milk", monday());
        assert_eq!(parsed.rule.entity_type, "task");
        assert_eq!(parsed.title, "buy milk");
    }

    #[test]
    fn a_slash_command_carries_its_priority_and_tags() {
        let parsed = parse("/bug the range bar renders at zero width", monday());
        assert_eq!(parsed.rule.entity_type, "task");
        assert_eq!(parsed.rule.priority, "high");
        assert_eq!(parsed.rule.tags, &["bug"]);
        assert_eq!(parsed.title, "the range bar renders at zero width");
    }

    #[test]
    fn an_alias_means_the_same_thing_as_the_command() {
        assert_eq!(
            parse("/t ship it", monday()).rule,
            parse("/task ship it", monday()).rule
        );
        assert_eq!(
            parse("/block waiting on legal", monday()).rule.priority,
            "urgent"
        );
    }

    #[test]
    fn a_longer_command_is_not_shadowed_by_a_shorter_one() {
        // `/block` and `/b`-anything: the longest token must win, or `/blocker` silently becomes
        // whatever shorter alias happened to match first.
        assert_eq!(parse("/blocker legal", monday()).rule.token, "/blocker");
        assert_eq!(parse("/block legal", monday()).rule.token, "/blocker");
    }

    #[test]
    fn an_unknown_slash_is_a_note_not_an_error() {
        // The web app treats it as text. Erroring here would make the two disagree on the one
        // input people produce by typo.
        let parsed = parse("/nonsense hello", monday());
        assert_eq!(parsed.rule.label, "Note");
        assert_eq!(parsed.title, "/nonsense hello");
    }

    #[test]
    fn a_command_is_case_insensitive_but_the_title_keeps_its_case() {
        let parsed = parse("/TASK Call Bob about Q3", monday());
        assert_eq!(parsed.rule.entity_type, "task");
        assert_eq!(parsed.title, "Call Bob about Q3");
    }

    // ---------- dates ----------

    #[test]
    fn tomorrow_is_tomorrow() {
        let parsed = parse("!call the accountant tomorrow", monday());
        assert_eq!(parsed.title, "call the accountant");
        assert_eq!(parsed.due.as_deref(), Some("2026-09-22"));
        assert_eq!(parsed.due_phrase.as_deref(), Some("tomorrow"));
    }

    #[test]
    fn a_weekday_means_the_coming_one() {
        // Monday the 21st; Friday is the 25th.
        assert_eq!(
            parse("!invoice friday", monday()).due.as_deref(),
            Some("2026-09-25")
        );
    }

    #[test]
    fn a_weekday_on_that_weekday_means_next_week() {
        // Someone typing "monday" on a Monday is naming a day they are not in the middle of.
        assert_eq!(
            parse("!standup monday", monday()).due.as_deref(),
            Some("2026-09-28")
        );
    }

    #[test]
    fn next_friday_is_a_week_past_friday() {
        assert_eq!(
            parse("!review next friday", monday()).due.as_deref(),
            Some("2026-10-02")
        );
    }

    #[test]
    fn in_n_days_counts_forward() {
        let parsed = parse("!chase the invoice in 3 days", monday());
        assert_eq!(parsed.title, "chase the invoice");
        assert_eq!(parsed.due.as_deref(), Some("2026-09-24"));
    }

    #[test]
    fn a_date_word_inside_the_sentence_is_not_a_due_date() {
        // "call Monday about the invoice" is not due on Monday. A parser that searched the whole
        // line for a weekday would say it was, and would be wrong about most real sentences.
        let parsed = parse("!call monday about the invoice", monday());
        assert_eq!(parsed.due, None);
        assert_eq!(parsed.title, "call monday about the invoice");
    }

    #[test]
    fn a_date_word_glued_to_another_word_is_not_a_date() {
        let parsed = parse("!check onfriday", monday());
        assert_eq!(
            parsed.due, None,
            "a suffix match inside a word is not a date"
        );
    }

    // ---------- projects ----------

    #[test]
    fn an_at_word_after_the_first_position_names_a_project() {
        let parsed = parse("!call the accountant tomorrow @Accounts", monday());
        assert_eq!(parsed.rule.entity_type, "task");
        assert_eq!(parsed.project.as_deref(), Some("Accounts"));
        assert_eq!(parsed.title, "call the accountant");
        assert_eq!(parsed.due.as_deref(), Some("2026-09-22"));
    }

    #[test]
    fn an_at_in_the_first_position_is_still_the_goal_prefix() {
        // The collision inherited from the TypeScript, resolved by position — see the module docs.
        let parsed = parse("@ ship v1 by Q2", monday());
        assert_eq!(parsed.rule.entity_type, "goal");
        assert_eq!(parsed.project, None);
        assert_eq!(parsed.title, "ship v1 by Q2");
    }

    #[test]
    fn only_the_first_project_reference_is_taken() {
        // Two is ambiguous. Silently picking one is worse than ignoring the second, and the echo
        // shows which was used.
        let parsed = parse("!thing @One @Two", monday());
        assert_eq!(parsed.project.as_deref(), Some("One"));
        assert_eq!(parsed.title, "thing @Two");
    }

    #[test]
    fn an_email_address_is_not_a_project() {
        let parsed = parse("!mail bob@example.com", monday());
        assert_eq!(
            parsed.project, None,
            "@ must be the first character of the word"
        );
        assert_eq!(parsed.title, "mail bob@example.com");
    }

    // ---------- the echo ----------

    #[test]
    fn the_echo_says_nothing_was_saved() {
        // A reply that reads like a confirmation, for an action that did not happen, is worse than
        // no reply at all.
        let echoed = echo(&parse("!call the accountant tomorrow @Accounts", monday()));
        assert!(echoed.contains("Nothing was saved"), "got:\n{echoed}");
    }

    #[test]
    fn the_echo_shows_the_phrase_as_well_as_the_date() {
        // "2026-09-25" alone is not checkable. "friday → 2026-09-25" is.
        let echoed = echo(&parse("!invoice friday", monday()));
        assert!(echoed.contains("2026-09-25"), "got:\n{echoed}");
        assert!(echoed.contains("friday"), "got:\n{echoed}");
    }

    #[test]
    fn an_empty_line_parses_to_an_empty_note_rather_than_panicking() {
        let parsed = parse("   ", monday());
        assert_eq!(parsed.rule.label, "Note");
        assert!(parsed.title.is_empty());
        assert!(echo(&parsed).contains("(no title)"));
    }
}
