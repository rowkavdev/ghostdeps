use clap::Parser;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    id: u32,
}

fn main() {
    let args = Args::parse();
    let _job = ws_core::Job { id: args.id };
}
