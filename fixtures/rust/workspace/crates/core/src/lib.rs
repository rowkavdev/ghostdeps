use serde::Serialize;

#[derive(Serialize)]
pub struct Job {
    pub id: u32,
}

pub fn spawn_job() {
    let _ = tokio::runtime::Builder::new_current_thread();
}
