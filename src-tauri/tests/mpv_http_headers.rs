#[path = "../src/mpv_engine/http_headers.rs"]
mod http_headers;

use std::collections::HashMap;

#[test]
fn escapes_commas_and_filters_newlines() {
    let headers = HashMap::from([
        ("User-Agent".to_string(), "yt-dlp".to_string()),
        ("Accept".to_string(), "a,b".to_string()),
        ("Bad\rName".to_string(), "ignored".to_string()),
    ]);
    assert_eq!(
        http_headers::mpv_http_header_fields(Some(&headers)),
        "%11%Accept: a,b,%18%User-Agent: yt-dlp",
    );
}
