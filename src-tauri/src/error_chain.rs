//! Rendering an error together with its causes.
//!
//! Shared because two independent networking paths — the app self-updater and
//! the extension/skin update checker — talk to the same hosts and hit the same
//! wall: reqwest 0.12+ deliberately keeps causes out of `Display`, so a failed
//! send stringifies to exactly `error sending request for url (…)` and names no
//! reason at all. Every reason that matters — DNS, TLS, `refused stream`,
//! `connection closed before message completed` — lives only in the `source()`
//! chain.
//!
//! Dropping it cost two things at once: a diagnostic report carrying a message
//! with no cause in it, and a frontend humanizer that pattern-matches on words
//! ("dns", "connect", "timed out") which could then never appear, so every
//! transport failure fell through to a generic sentence.

/// Flatten an error's `Display` **and its whole source chain** into one string.
pub fn err_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(cause) = src {
        out.push_str(": ");
        out.push_str(&cause.to_string());
        src = cause.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Layer(&'static str, Option<Box<Layer>>);

    impl std::fmt::Display for Layer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for Layer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_deref().map(|l| l as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn test_err_chain_keeps_the_cause_the_display_drops() {
        // reqwest's real shape: the top line names only the URL, and the reason
        // this failed lives two levels down.
        let e = Layer(
            "error sending request for url (https://example/latest.json)",
            Some(Box::new(Layer(
                "client error (SendRequest)",
                Some(Box::new(Layer(
                    "stream error received: refused stream before processing any application logic",
                    None,
                ))),
            ))),
        );
        let text = err_chain(&e);
        assert!(text.starts_with("error sending request for url"), "{text}");
        assert!(text.contains("refused stream"), "{text}");
    }

    #[test]
    fn test_err_chain_of_a_causeless_error_is_just_its_message() {
        assert_eq!(err_chain(&Layer("no pending update", None)), "no pending update");
    }
}
