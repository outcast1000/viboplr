use std::collections::HashMap;

/// The `Name: value` lines to hand mpv for a request, sorted for determinism.
/// Header lines are filtered defensively because plugin-provided values must
/// never introduce CR/LF into an HTTP request.
///
/// These are applied ONE AT A TIME via mpv's `change-list` command, never by
/// writing a delimited string into the `http-header-fields` property. That was
/// the original approach and it is silently broken: `http-header-fields` is a
/// **comma-delimited list**, and mpv's documented `%<len>%<item>` escape — which
/// exists precisely to protect items containing commas — is honoured only by the
/// option-string parser, not by a property write. Setting the property put the
/// literal prefixes on the wire as part of the header NAME and split every value
/// on its commas into lines with no colon at all. Captured from a real request:
///
/// ```text
/// "%33%Accept: text/html"            <- prefix leaked into the name
/// "application/xml"                  <- no colon: a malformed header line
/// "%38%User-Agent: UA/1.0 (KHTML"
/// " like Gecko)"                     <- same
/// ```
///
/// Two failures followed, and between them they account for essentially every
/// yt-dlp playback failure: a malformed line made the whole request invalid, so
/// signed CDN hosts answered **400 Bad Request**; and because the real
/// `User-Agent` never arrived (mpv sent its own `libmpv`), a URL bound to the UA
/// that minted it answered **403 Forbidden**. Both read as "the stream is dead"
/// while the stream was fine.
pub fn mpv_http_header_lines(headers: Option<&HashMap<String, String>>) -> Vec<String> {
    let mut fields: Vec<String> = headers
        .into_iter()
        .flat_map(|headers| headers.iter())
        .filter(|(name, value)| !name.is_empty() && !name.contains(['\r', '\n']) && !value.contains(['\r', '\n']))
        .map(|(name, value)| format!("{name}: {value}"))
        .collect();
    fields.sort();
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn test_header_lines_are_whole_values_not_split_on_commas() {
        // The regression this module exists for: a value with commas is ONE
        // header line. Anything that splits it produces a line with no colon,
        // which invalidates the entire request.
        let h = headers(&[("Accept", "text/html,application/xml;q=0.9")]);
        assert_eq!(mpv_http_header_lines(Some(&h)), vec!["Accept: text/html,application/xml;q=0.9"]);
    }

    #[test]
    fn test_header_lines_carry_no_length_prefix() {
        // The `%<len>%` escape belongs to mpv's option-string parser; emitting it
        // here put it on the wire inside the header name.
        let h = headers(&[("User-Agent", "UA/1.0 (KHTML, like Gecko)")]);
        let lines = mpv_http_header_lines(Some(&h));
        assert_eq!(lines, vec!["User-Agent: UA/1.0 (KHTML, like Gecko)"]);
        assert!(!lines[0].starts_with('%'), "no length prefix");
    }

    #[test]
    fn test_header_lines_reject_crlf_injection() {
        let h = headers(&[
            ("X-Bad", "value\r\nInjected: yes"),
            ("X-Also\nBad", "v"),
            ("X-Good", "fine"),
        ]);
        assert_eq!(mpv_http_header_lines(Some(&h)), vec!["X-Good: fine"]);
    }

    #[test]
    fn test_no_headers_is_an_empty_list() {
        assert!(mpv_http_header_lines(None).is_empty());
        assert!(mpv_http_header_lines(Some(&HashMap::new())).is_empty());
    }

    #[test]
    fn test_header_lines_are_sorted_for_determinism() {
        let h = headers(&[("User-Agent", "ua"), ("Accept", "a"), ("Referer", "r")]);
        assert_eq!(
            mpv_http_header_lines(Some(&h)),
            vec!["Accept: a", "Referer: r", "User-Agent: ua"],
        );
    }
}
