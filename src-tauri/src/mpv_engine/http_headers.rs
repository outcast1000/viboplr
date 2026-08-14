use std::collections::HashMap;

/// Encode a string-list value for mpv's comma-delimited option parser. The
/// length prefix keeps commas inside header values (notably Accept) from being
/// mistaken for another option. Header lines are filtered defensively because
/// plugin-provided values must never introduce CR/LF into an HTTP request.
pub fn mpv_http_header_fields(headers: Option<&HashMap<String, String>>) -> String {
    let mut fields: Vec<String> = headers
        .into_iter()
        .flat_map(|headers| headers.iter())
        .filter(|(name, value)| !name.is_empty() && !name.contains(['\r', '\n']) && !value.contains(['\r', '\n']))
        .map(|(name, value)| format!("{name}: {value}"))
        .collect();
    fields.sort();
    fields
        .into_iter()
        .map(|field| format!("%{}%{field}", field.len()))
        .collect::<Vec<_>>()
        .join(",")
}
