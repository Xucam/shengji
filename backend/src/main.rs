#![deny(warnings)]

use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use axum::{
    extract::ws::{Message, WebSocketUpgrade},
    response::{IntoResponse, Redirect},
    routing::{get, post},
    Extension, Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use slog::{debug, error, info, o, Drain, Logger};
use tokio::sync::{mpsc, Mutex};

#[cfg(feature = "dynamic")]
use axum::routing::get_service;
#[cfg(not(feature = "dynamic"))]
use axum::{
    body::{Empty, Full},
    extract::Path,
    response::Response,
};
use http::{HeaderValue, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};
#[cfg(feature = "dynamic")]
use tower_http::services::ServeDir;

use shengji_core::settings;
use shengji_mechanics::types::FULL_DECK;
use shengji_types::ZSTD_ZSTD_DICT;
use storage::{HashMapStorage, Storage};

mod dealing;
mod serving_types;
mod shengji_handler;
mod state_dump;
mod utils;
mod wasm_rpc_handler;

use serving_types::{CardsBlob, VersionedGame};
use state_dump::InMemoryStats;

/// Our global unique user id counter.
static NEXT_USER_ID: AtomicUsize = AtomicUsize::new(1);

lazy_static::lazy_static! {
    static ref CARDS_JSON: CardsBlob = CardsBlob {
        cards: FULL_DECK.iter().map(|c| c.as_info()).collect()
    };

    static ref ROOT_LOGGER: Logger = {
        #[cfg(not(feature = "dynamic"))]
        let drain = slog_bunyan::default(std::io::stdout());
        #[cfg(feature = "dynamic")]
        let drain = slog_term::FullFormat::new(slog_term::TermDecorator::new().build()).build();

        let version = std::env::var("VERSION").unwrap_or_else(|_| "unknown_dev".to_string());

        Logger::root(
            slog_async::Async::new(drain.fuse()).build().fuse(),
            o!("version" => version)
        )
    };

    static ref ZSTD_COMPRESSOR: std::sync::Mutex<zstd::bulk::Compressor<'static>> = {
        // default zstd dictionary size is 112_640
        let comp = zstd::bulk::Compressor::with_dictionary(0, &zstd::bulk::decompress(ZSTD_ZSTD_DICT, 112_640).unwrap()).unwrap();
        std::sync::Mutex::new(comp)
    };

    static ref VERSION: String = {
        std::env::var("VERSION").unwrap_or_else(|_| "unknown_dev".to_string())
    };

    static ref DUMP_PATH: String = {
        std::env::var("DUMP_PATH").unwrap_or_else(|_| "/tmp/shengji_state.json".to_string())
    };
    static ref MESSAGE_PATH: String = {
        std::env::var("MESSAGE_PATH").unwrap_or_else(|_| "/tmp/shengji_messages.json".to_string())
    };
    static ref WEBSOCKET_HOST: Option<String> = {
        std::env::var("WEBSOCKET_HOST").ok()
    };
}

async fn runtime_settings() -> impl IntoResponse {
    let body = match WEBSOCKET_HOST.as_ref() {
        Some(s) => format!(
            "window._WEBSOCKET_HOST = \"{}\";window._VERSION = \"{}\";",
            s, *VERSION,
        ),
        None => format!(
            "window._WEBSOCKET_HOST = null;window._VERSION = \"{}\";",
            *VERSION
        ),
    };
    (
        [(http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        body,
    )
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    ctrlc::set_handler(move || {
        info!(ROOT_LOGGER, "Received SIGTERM, shutting down");
        std::process::exit(0);
    })
    .unwrap();

    let (backend_storage, stats) = state_dump::load_state().await?;

    tokio::task::spawn(periodically_dump_state(
        backend_storage.clone(),
        stats.clone(),
    ));

    tokio::task::spawn(dealing::run(backend_storage.clone()));

    let app = Router::new()
        .route("/api", get(handle_websocket))
        .route("/api/rpc", post(wasm_rpc_handler::handle_wasm_rpc))
        .route(
            "/default_settings.json",
            get(|| async { Json(settings::PropagatedState::default()) }),
        )
        .route("/full_state.json", get(state_dump::dump_state))
        .route("/stats", get(get_stats))
        .route("/runtime.js", get(runtime_settings))
        .route("/cards.json", get(|| async { Json(CARDS_JSON.clone()) }))
        .route(
            "/rules",
            get(|| async { Redirect::permanent("/rules.html") }),
        )
        .route("/public_games.json", get(state_dump::public_games));

    #[cfg(feature = "dynamic")]
    let app = app.fallback_service(get_service(
        ServeDir::new("../frontend/dist").fallback(ServeDir::new("../favicon")),
    ));
    #[cfg(not(feature = "dynamic"))]
    let app = app
        .route(
            "/",
            get(|| async { serve_static_routes(Path("index.html".to_string())).await }),
        )
        .route("/*path", get(serve_static_routes));

    // Configure CORS based on environment variables
    // CORS_ALLOWED_ORIGINS: comma-separated list of allowed origins (e.g., "http://localhost:3000,https://example.com")
    // Set to "*" to allow any origin (not recommended for production)
    // If not set, defaults to allowing localhost origins in development
    let cors = {
        let allowed_origins = std::env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| {
                // Default to common development origins if not specified
                "http://localhost:3000,http://localhost:3030,http://127.0.0.1:3000,http://127.0.0.1:3030".to_string()
            });

        if allowed_origins.trim() == "*" {
            // Allow any origin (use with caution)
            info!(
                ROOT_LOGGER,
                "CORS configured to allow ANY origin - not recommended for production"
            );
            CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers(tower_http::cors::Any)
        } else {
            let origins: Vec<HeaderValue> = allowed_origins
                .split(',')
                .filter_map(|origin| origin.trim().parse::<HeaderValue>().ok())
                .collect();

            if origins.is_empty() {
                // If no valid origins, fall back to same-origin only
                info!(
                    ROOT_LOGGER,
                    "No valid CORS origins configured, using same-origin policy"
                );
                CorsLayer::new()
            } else {
                info!(ROOT_LOGGER, "CORS origins configured: {:?}", origins);
                CorsLayer::new()
                    .allow_origin(AllowOrigin::list(origins))
                    .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                    .allow_headers(tower_http::cors::Any)
            }
        }
    };

    let app = app
        .layer(cors)
        .layer(Extension(backend_storage))
        .layer(Extension(stats));

    axum::Server::bind(&SocketAddr::from(([0, 0, 0, 0], 3030)))
        .serve(app.into_make_service())
        .await?;

    info!(ROOT_LOGGER, "Shutting down");
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
struct GameStats {
    num_games_created: u64,
    num_active_games: usize,
    num_players_online_now: usize,
    sha: &'static str,
}

async fn get_stats(
    Extension(backend_storage): Extension<HashMapStorage<VersionedGame>>,
) -> Result<Json<GameStats>, &'static str> {
    let num_games_created = backend_storage
        .clone()
        .get_states_created()
        .await
        .map_err(|_| "failed to get number of games created")?;
    let (num_active_games, num_players_online_now) = backend_storage
        .clone()
        .stats()
        .await
        .map_err(|_| "failed to get number of active games and online players")?;
    Ok(Json(GameStats {
        num_games_created,
        num_players_online_now,
        num_active_games,
        sha: &VERSION,
    }))
}

async fn periodically_dump_state(
    backend_storage: HashMapStorage<VersionedGame>,
    stats: Arc<Mutex<InMemoryStats>>,
) {
    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
    loop {
        interval.tick().await;
        let _ =
            state_dump::dump_state(Extension(backend_storage.clone()), Extension(stats.clone()))
                .await;
    }
}

async fn handle_websocket(
    ws: WebSocketUpgrade,
    Extension(backend_storage): Extension<HashMapStorage<VersionedGame>>,
    Extension(stats): Extension<Arc<Mutex<InMemoryStats>>>,
) -> impl IntoResponse {
    ws.on_upgrade(|ws| async move {
        let ws_id = NEXT_USER_ID.fetch_add(1, Ordering::Relaxed);
        let logger = ROOT_LOGGER.new(o!("ws_id" => ws_id));
        info!(logger, "Websocket connection initialized");
        let (mut user_ws_tx, mut user_ws_rx) = ws.split();
        let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (heartbeat_tx, mut heartbeats) = mpsc::channel::<()>(1);

        let writer_logger = logger.clone();
        let writer_closed_tx = closed_tx.clone();
        let mut writer_closed_rx = closed_rx.clone();
        tokio::task::spawn(async move {
            let mut ping = tokio::time::interval(tokio::time::Duration::from_secs(25));
            ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                let message = tokio::select! {
                    _ = writer_closed_rx.changed() => break,
                    value = rx.recv() => match value {
                        Some(bytes) => Message::Binary(bytes),
                        None => break,
                    },
                    value = heartbeats.recv() => match value {
                        Some(()) => Message::Text("\"Heartbeat\"".to_owned()),
                        None => break,
                    },
                    _ = ping.tick() => Message::Ping(vec![]),
                };
                let result = tokio::select! {
                    _ = writer_closed_rx.changed() => break,
                    result = tokio::time::timeout(
                        tokio::time::Duration::from_secs(60), user_ws_tx.send(message)
                    ) => result,
                };
                match result {
                    Ok(Ok(())) => (),
                    Ok(Err(error)) => {
                        error!(writer_logger, "Websocket send failed"; "error" => format!("{error:?}"));
                        break;
                    }
                    Err(_) => {
                        info!(writer_logger, "Websocket send timed out");
                        break;
                    }
                }
            }
            let _ = writer_closed_tx.send(true);
            let _ = tokio::time::timeout(
                tokio::time::Duration::from_secs(1), user_ws_tx.close()
            ).await;
            debug!(writer_logger, "Ending tx task");
        });

        let reader_logger = logger.clone();
        let reader_closed_tx = closed_tx.clone();
        let mut reader_closed_rx = closed_rx;
        let (tx2, rx2) = mpsc::unbounded_channel();
        tokio::task::spawn(async move {
            loop {
                let incoming = tokio::select! {
                    _ = reader_closed_rx.changed() => break,
                    result = tokio::time::timeout(
                        tokio::time::Duration::from_secs(90), user_ws_rx.next()
                    ) => match result {
                        Ok(Some(result)) => result,
                        Ok(None) => {
                            info!(reader_logger, "Websocket stream ended");
                            break;
                        }
                        Err(_) => {
                            info!(reader_logger, "Websocket receive timed out");
                            break;
                        }
                    },
                };
                match incoming {
                    Ok(Message::Close(frame)) => {
                        let (code, reason) = frame
                            .map(|frame| (Some(frame.code), frame.reason.into_owned()))
                            .unwrap_or_default();
                        info!(reader_logger, "Websocket close received";
                            "code" => code, "reason" => reason);
                        break;
                    }
                    Ok(Message::Text(text)) if text == "\"Heartbeat\"" => {
                        // Transport-level response also works before joining a room.
                        if heartbeat_tx.send(()).await.is_err() { break; }
                    }
                    Ok(Message::Binary(bytes)) => {
                        if tx2.send(bytes).is_err() { break; }
                    }
                    Ok(Message::Text(text)) => {
                        if tx2.send(text.into_bytes()).is_err() { break; }
                    }
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => (),
                    Err(error) => {
                        error!(reader_logger, "Failed to fetch message"; "error" => format!("{error:?}"));
                        break;
                    }
                }
            }
            let _ = reader_closed_tx.send(true);
            debug!(reader_logger, "Ending rx task");
        });

        shengji_handler::entrypoint(tx, rx2, ws_id, logger, backend_storage, stats).await;
        // Any session, reader, or writer ending cancels the other socket tasks.
        let _ = closed_tx.send(true);
    })
}

#[cfg(not(feature = "dynamic"))]
async fn serve_static_routes(Path(path): Path<String>) -> impl IntoResponse {
    static DIST: include_dir::Dir<'_> = include_dir::include_dir!("frontend/dist");
    static FAVICON: include_dir::Dir<'_> = include_dir::include_dir!("favicon");
    let mime_type = mime_guess::from_path(&path).first_or_text_plain();

    match DIST.get_file(&path).or_else(|| FAVICON.get_file(&path)) {
        Some(f) => Response::builder()
            .status(axum::http::StatusCode::OK)
            .header(
                http::header::CONTENT_TYPE,
                http::HeaderValue::from_str(mime_type.as_ref()).unwrap(),
            )
            .body(axum::body::boxed(Full::from(f.contents())))
            .unwrap(),
        None => Response::builder()
            .status(axum::http::StatusCode::NOT_FOUND)
            .body(axum::body::boxed(Empty::new()))
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::CARDS_JSON;

    static CARDS_JSON_FROM_FILE: &str = include_str!("../../frontend/src/generated/cards.json");

    #[test]
    fn test_cards_json_compatibility() {
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &serde_json::to_string(&*CARDS_JSON).unwrap()
            )
            .unwrap(),
            serde_json::from_str::<serde_json::Value>(CARDS_JSON_FROM_FILE).unwrap(),
            "Run `yarn download-cards-json` with the backend running to sync the generated cards.json file"
        );
    }
}
