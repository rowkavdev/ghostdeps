use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Config {
    name: String,
}

fn main() -> anyhow::Result<()> {
    let config: Config = json::from_str(r#"{"name":"x"}"#)?;
    println!("{}", config.name);
    Ok(())
}
