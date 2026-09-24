#[cfg(feature = "json")]
pub fn to_json(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

#[cfg(windows)]
pub fn beep() {
    unsafe { winapi::um::winuser::MessageBeep(0) };
}
