//! Text for a phone: the two pieces every bot reply is built from.
//!
//! They were written out separately in each reply — `/today`, `/next`, `/inbox`, `/week` and the
//! habits nudge — and had already drifted: `bot_life` cut long titles at sixty characters and the
//! nudge did not, so a habit with a long name produced a message the others were careful not to.

/// A title as it should appear in a list: trimmed, never blank, never wider than a lock screen.
///
/// Cut by characters rather than bytes, so a title full of emoji cannot be split mid-codepoint.
pub fn title(raw: Option<&str>) -> String {
    const WIDTH: usize = 60;
    let title = raw.map(str::trim).filter(|t| !t.is_empty()).unwrap_or("(untitled)");
    if title.chars().count() > WIDTH {
        format!("{}…", title.chars().take(WIDTH - 1).collect::<String>())
    } else {
        title.to_string()
    }
}

/// One line per row up to `shown`, then a count of the rest instead of the rest itself.
///
/// Past a handful of lines the useful thing is the number, not the seventh line — a message you
/// have to scroll on a lock screen is one you deal with later.
pub fn bullets<T>(rows: &[T], shown: usize, render: impl Fn(&T) -> String) -> String {
    let mut out: Vec<String> = rows.iter().take(shown).map(render).collect();
    if rows.len() > shown {
        out.push(format!("…and {} more", rows.len() - shown));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_title_is_named_as_such() {
        assert_eq!(title(None), "(untitled)");
        assert_eq!(title(Some("   ")), "(untitled)");
        assert_eq!(title(Some("  Pay rent ")), "Pay rent");
    }

    #[test]
    fn a_long_title_is_cut_on_characters() {
        let cut = title(Some(&"🙂".repeat(80)));
        assert!(cut.ends_with('…'));
        assert_eq!(cut.chars().count(), 60);
    }

    #[test]
    fn the_tail_is_counted_not_listed() {
        let rows: Vec<u32> = (0..10).collect();
        let text = bullets(&rows, 3, |n| format!("• {n}"));
        assert_eq!(text, "• 0\n• 1\n• 2\n…and 7 more");
        assert_eq!(bullets(&rows[..2], 3, |n| n.to_string()), "0\n1", "no count when it all fits");
    }
}
