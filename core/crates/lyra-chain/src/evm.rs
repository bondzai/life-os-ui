//! EVM JSON-RPC: the `eth_call` / `eth_getBalance` seam every DeFi adapter reads through.
//!
//! `portfolio.py` talks to chains two ways: `_rpc_native_balance` posts a raw `eth_getBalance`,
//! and everything else goes through `w3.eth.contract(...).functions.foo().call()`, which is an
//! `eth_call` with ABI-encoded calldata. Both are here, behind one small trait so an adapter can
//! be tested without a network.
//!
//! There is no batching or multicall: the oracle makes one call per read (checked — no
//! `multicall`/`aggregate` anywhere in `portfolio.py`), and the port matches it so that a parity
//! run compares like with like. Concurrency is the caller's business; run several futures with
//! `tokio::join!` if you want them in flight together.
//!
//! # The seam
//!
//! Adapters take `&R where R: EvmRpc` (or `&dyn EvmRpc` — the trait is object-safe) and use the
//! [`EvmRpcExt`] helpers rather than encoding by hand:
//!
//! ```no_run
//! use lyra_chain::abi::{Fields, Value};
//! use lyra_chain::evm::{EvmRpc, EvmRpcExt};
//!
//! async fn read_position<R: EvmRpc>(rpc: &R, npm: &str, token_id: u64) -> anyhow::Result<i32> {
//!     let p = rpc
//!         .call_typed(
//!             npm,
//!             "positions(uint256)",
//!             &[Value::uint(token_id)],
//!             "uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,\
//!              uint128,uint128",
//!         )
//!         .await?;
//!     p.at(5)?.as_i32() // tickLower — signed, so `int24` in the output list
//! }
//! ```
//!
//! # Testing without a network
//!
//! [`MockRpc`] answers stubbed calls and refuses everything else, naming what *was* stubbed so a
//! typo in a selector is obvious:
//!
//! ```
//! use lyra_chain::abi::Value;
//! use lyra_chain::evm::MockRpc;
//!
//! # fn main() -> anyhow::Result<()> {
//! let rpc = MockRpc::new().returns(
//!     "0xc36442b4a4522e871399cd717abdd847ab11fe88",
//!     "positions(uint256)",
//!     &[Value::uint(1u64)],
//!     &[Value::uint(0u64) /* … the rest of the tuple … */],
//! )?;
//! # let _ = rpc;
//! # Ok(())
//! # }
//! ```
//!
//! Against a live node, [`HttpRpc`] posts through [`crate::http_cache::HttpCache`], so a recorded
//! fixture replays byte-for-byte and a parity run is not racing the chain.

use crate::abi::{self, U256, Value};
use crate::chains::Chain;
use crate::http_cache::HttpCache;
use anyhow::{Context, Result, anyhow, bail};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

/// A boxed future, so the trait below stays object-safe.
///
/// `async fn` in a trait is not dyn-compatible, and adapters benefit from being able to hold a
/// `&dyn EvmRpc` (one adapter registry, many chains) more than they benefit from the sugar.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The two chain reads the portfolio needs. Implement this to stand in for a node.
///
/// Object-safe on purpose: `Arc<dyn EvmRpc>` works, and so does a generic `R: EvmRpc`.
/// Implementations must be cheap to share (`&self`, no interior mutation that a caller can
/// observe) because adapters read many positions concurrently from one instance.
///
/// Implementors return a boxed future; the body is a normal `async move` block:
///
/// ```
/// use lyra_chain::abi::U256;
/// use lyra_chain::evm::{BoxFuture, EvmRpc};
///
/// struct AlwaysEmpty;
///
/// impl EvmRpc for AlwaysEmpty {
///     fn eth_call<'a>(&'a self, _to: &'a str, _data: &'a [u8]) -> BoxFuture<'a, anyhow::Result<Vec<u8>>> {
///         Box::pin(async move { Ok(Vec::new()) })
///     }
///     fn eth_get_balance<'a>(&'a self, _address: &'a str) -> BoxFuture<'a, anyhow::Result<U256>> {
///         Box::pin(async move { Ok(U256::ZERO) })
///     }
/// }
/// ```
pub trait EvmRpc: Send + Sync {
    /// A `view` call against `to` with ABI-encoded `data`, at the latest block.
    ///
    /// Returns the raw return bytes. An empty vector means the node returned `0x` — no contract
    /// at that address, or a function that returned nothing; [`crate::abi::decode`] turns that
    /// into an error rather than a zero value. A revert is an `Err`, with the revert reason
    /// decoded into the message when the contract provided one.
    fn eth_call<'a>(&'a self, to: &'a str, data: &'a [u8]) -> BoxFuture<'a, Result<Vec<u8>>>;

    /// The native-coin balance of `address` in wei — `portfolio.py:_rpc_native_balance`, minus
    /// its division by 1e18. Scaling belongs to the caller, which knows the coin's decimals.
    fn eth_get_balance<'a>(&'a self, address: &'a str) -> BoxFuture<'a, Result<U256>>;

    /// A short name for this endpoint, used in error messages (chain name, or `mock`).
    fn label(&self) -> &str {
        "evm"
    }
}

impl<T: EvmRpc + ?Sized> EvmRpc for std::sync::Arc<T> {
    fn eth_call<'a>(&'a self, to: &'a str, data: &'a [u8]) -> BoxFuture<'a, Result<Vec<u8>>> {
        (**self).eth_call(to, data)
    }

    fn eth_get_balance<'a>(&'a self, address: &'a str) -> BoxFuture<'a, Result<U256>> {
        (**self).eth_get_balance(address)
    }

    fn label(&self) -> &str {
        (**self).label()
    }
}

impl<T: EvmRpc + ?Sized> EvmRpc for &T {
    fn eth_call<'a>(&'a self, to: &'a str, data: &'a [u8]) -> BoxFuture<'a, Result<Vec<u8>>> {
        (**self).eth_call(to, data)
    }

    fn eth_get_balance<'a>(&'a self, address: &'a str) -> BoxFuture<'a, Result<U256>> {
        (**self).eth_get_balance(address)
    }

    fn label(&self) -> &str {
        (**self).label()
    }
}

/// Typed calling on top of [`EvmRpc`] — encode arguments, call, decode outputs.
///
/// Blanket-implemented, including for `dyn EvmRpc`, so every implementation gets it for free.
pub trait EvmRpcExt: EvmRpc {
    /// Call `signature` on `to` with `args`, decoding the result against `outputs`.
    ///
    /// `outputs` is the Solidity output list as written in the ABI —
    /// `"uint160,int24,uint16,uint16,uint16,uint8,bool"` for a v3 `slot0()`. Signed fields must
    /// be declared `intN`; see the sign-extension note in [`crate::abi`].
    fn call_typed<'a>(
        &'a self,
        to: &'a str,
        signature: &'a str,
        args: &'a [Value],
        outputs: &'a str,
    ) -> impl Future<Output = Result<Vec<Value>>> + Send + 'a {
        async move {
            let data = abi::encode_call(signature, args)
                .with_context(|| format!("encoding {signature}"))?;
            let raw = self
                .eth_call(to, &data)
                .await
                .with_context(|| format!("{} {signature} on {to}", self.label()))?;
            abi::decode(outputs, &raw).with_context(|| {
                format!(
                    "{} {signature} on {to} returned {}",
                    self.label(),
                    abi::hex_encode(&raw)
                )
            })
        }
    }

    /// [`EvmRpcExt::call_typed`] for the common single-output case (`balanceOf`, `getPool`, …).
    fn call_one<'a>(
        &'a self,
        to: &'a str,
        signature: &'a str,
        args: &'a [Value],
        output: &'a str,
    ) -> impl Future<Output = Result<Value>> + Send + 'a {
        async move {
            let mut out = self.call_typed(to, signature, args, output).await?;
            if out.len() != 1 {
                bail!(
                    "{signature} on {to} returned {} values, expected 1",
                    out.len()
                );
            }
            Ok(out.remove(0))
        }
    }
}

impl<T: EvmRpc + ?Sized> EvmRpcExt for T {}

// ===========================================================================
// The live implementation
// ===========================================================================

/// A JSON-RPC endpoint, reached through the record/replay [`HttpCache`].
#[derive(Debug, Clone)]
pub struct HttpRpc {
    client: reqwest::Client,
    cache: HttpCache,
    url: String,
    label: String,
}

impl HttpRpc {
    /// A client for an arbitrary endpoint.
    pub fn new(
        client: reqwest::Client,
        cache: HttpCache,
        url: impl Into<String>,
        label: impl Into<String>,
    ) -> Self {
        Self {
            client,
            cache,
            url: url.into(),
            label: label.into(),
        }
    }

    /// A client for a configured chain. Errors for a chain with no `rpc` (Bitcoin, Solana),
    /// which is the same "this chain is not EVM" signal `portfolio.py` gets from `cfg["rpc"]`.
    pub fn for_chain(client: reqwest::Client, cache: HttpCache, chain: &Chain) -> Result<Self> {
        let url = chain
            .rpc
            .ok_or_else(|| anyhow!("chain {} has no EVM RPC endpoint", chain.name))?;
        Ok(Self::new(client, cache, url, chain.name))
    }

    /// The endpoint URL, for logging.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// One JSON-RPC round trip, returning the `result` member.
    async fn request(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let recorded = self
            .cache
            .post_json(&self.client, &self.url, &body)
            .await
            .with_context(|| format!("{method} on {}", self.label))?;

        if recorded.status != 200 {
            bail!(
                "{} returned HTTP {} for {method}: {}",
                self.url,
                recorded.status,
                truncate(&recorded.body)
            );
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&recorded.body).with_context(|| {
                format!(
                    "{method} response was not JSON: {}",
                    truncate(&recorded.body)
                )
            })?;

        if let Some(error) = parsed.get("error").filter(|e| !e.is_null()) {
            bail!("{method} failed on {}: {}", self.label, rpc_error(error));
        }
        parsed.get("result").cloned().ok_or_else(|| {
            anyhow!(
                "{method} response had no result: {}",
                truncate(&recorded.body)
            )
        })
    }
}

impl EvmRpc for HttpRpc {
    fn eth_call<'a>(&'a self, to: &'a str, data: &'a [u8]) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            // The same shape web3.py puts on the wire: {to, data} plus a block tag.
            let params = serde_json::json!([
                {"to": to, "data": abi::hex_encode(data)},
                "latest",
            ]);
            let result = self.request("eth_call", params).await?;
            let hex = result
                .as_str()
                .ok_or_else(|| anyhow!("eth_call result was not a hex string: {result}"))?;
            abi::hex_decode(hex).with_context(|| format!("eth_call on {to} returned {hex}"))
        })
    }

    fn eth_get_balance<'a>(&'a self, address: &'a str) -> BoxFuture<'a, Result<U256>> {
        Box::pin(async move {
            let params = serde_json::json!([address, "latest"]);
            let result = self.request("eth_getBalance", params).await?;
            let hex = result
                .as_str()
                .ok_or_else(|| anyhow!("eth_getBalance result was not a hex string: {result}"))?;
            U256::from_hex(hex).with_context(|| format!("eth_getBalance for {address}"))
        })
    }

    fn label(&self) -> &str {
        &self.label
    }
}

/// Render a JSON-RPC error object, decoding a `Error(string)` revert payload when there is one.
fn rpc_error(error: &serde_json::Value) -> String {
    let message = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown error");
    let code = error.get("code").and_then(serde_json::Value::as_i64);
    let reason = error
        .get("data")
        .and_then(serde_json::Value::as_str)
        .and_then(revert_reason);
    match (code, reason) {
        (Some(code), Some(reason)) => format!("{message} (code {code}): {reason}"),
        (Some(code), None) => format!("{message} (code {code})"),
        (None, Some(reason)) => format!("{message}: {reason}"),
        (None, None) => message.to_string(),
    }
}

/// The string inside a standard `Error(string)` revert payload, if that is what this is.
fn revert_reason(data: &str) -> Option<String> {
    let bytes = abi::hex_decode(data).ok()?;
    // keccak("Error(string)")[..4]
    let selector = abi::selector("Error(string)").ok()?;
    if bytes.len() < 4 || bytes[..4] != selector {
        return None;
    }
    let decoded = abi::decode("string", &bytes[4..]).ok()?;
    decoded.first()?.as_str().ok().map(str::to_string)
}

fn truncate(body: &str) -> String {
    const MAX: usize = 300;
    if body.len() <= MAX {
        return body.to_string();
    }
    let mut end = MAX;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… ({} bytes)", &body[..end], body.len())
}

// ===========================================================================
// The mock
// ===========================================================================

/// What a stubbed call answers with.
#[derive(Debug, Clone)]
enum Reply {
    Data(Vec<u8>),
    Revert(String),
}

/// A call the mock was asked to make.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCall {
    /// Contract address, lowercased.
    pub to: String,
    /// Calldata as `0x…` hex.
    pub data: String,
}

/// An [`EvmRpc`] that answers from a table instead of a network.
///
/// Build it with the `returns*` / `reverts` / `balance` methods; each returns `Self` so they
/// chain. Lookup goes exact calldata first, then selector-only, so a stub for
/// `positions(uint256)` with specific arguments wins over a catch-all for the same function.
/// An unstubbed call is an error that lists what *is* stubbed — a wrong selector or a
/// mis-encoded argument shows up immediately instead of as a confusing decode failure.
#[derive(Debug, Default)]
pub struct MockRpc {
    /// (to, calldata hex) -> reply
    exact: HashMap<(String, String), Reply>,
    /// (to, selector hex) -> reply, matching any arguments
    by_selector: HashMap<(String, String), Reply>,
    balances: HashMap<String, U256>,
    calls: Mutex<Vec<RecordedCall>>,
}

impl MockRpc {
    /// An empty mock: every call is an error until something is stubbed.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Stub `signature(args)` on `to` to return `outputs`, ABI-encoded.
    ///
    /// This is the usual one: it encodes both sides exactly as a node would, so the test
    /// exercises the real calldata and the real decode.
    pub fn returns(
        self,
        to: &str,
        signature: &str,
        args: &[Value],
        outputs: &[Value],
    ) -> Result<Self> {
        let data = abi::encode_call(signature, args)?;
        self.returns_raw(
            to,
            &abi::hex_encode(&data),
            &abi::hex_encode(&abi::encode(outputs)),
        )
    }

    /// Stub `signature` on `to` for **any** arguments — handy for `slot0()`-style reads where
    /// the test does not care which token id asked.
    pub fn returns_for_any_args(
        self,
        to: &str,
        signature: &str,
        outputs: &[Value],
    ) -> Result<Self> {
        let selector = abi::selector(signature)?;
        let mut this = self;
        this.by_selector.insert(
            (to.to_lowercase(), abi::hex_encode(&selector)),
            Reply::Data(abi::encode(outputs)),
        );
        Ok(this)
    }

    /// Stub raw hex in and raw hex out — for pasting a response captured from a real node.
    pub fn returns_raw(mut self, to: &str, calldata_hex: &str, return_hex: &str) -> Result<Self> {
        let data = abi::hex_decode(calldata_hex).context("calldata hex")?;
        let ret = abi::hex_decode(return_hex).context("return hex")?;
        self.exact.insert(
            (to.to_lowercase(), abi::hex_encode(&data)),
            Reply::Data(ret),
        );
        Ok(self)
    }

    /// Stub `signature` on `to` to return `0x` — what a node says when the address has no code.
    pub fn returns_nothing(self, to: &str, signature: &str) -> Result<Self> {
        self.returns_for_any_args(to, signature, &[])
    }

    /// Stub `signature` on `to` to revert with `message`.
    pub fn reverts(mut self, to: &str, signature: &str, message: &str) -> Result<Self> {
        let selector = abi::selector(signature)?;
        self.by_selector.insert(
            (to.to_lowercase(), abi::hex_encode(&selector)),
            Reply::Revert(message.to_string()),
        );
        Ok(self)
    }

    /// Set the native balance (in wei) reported for an address.
    #[must_use]
    pub fn balance(mut self, address: &str, wei: U256) -> Self {
        self.balances.insert(address.to_lowercase(), wei);
        self
    }

    /// Every call made so far, in order — for asserting an adapter read what it should have.
    ///
    /// # Panics
    /// If a previous call panicked while the lock was held.
    #[must_use]
    pub fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().expect("mock call log poisoned").clone()
    }

    /// How many `eth_call`s have been made.
    ///
    /// # Panics
    /// If a previous call panicked while the lock was held.
    #[must_use]
    pub fn call_count(&self) -> usize {
        self.calls.lock().expect("mock call log poisoned").len()
    }

    fn lookup(&self, to: &str, data: &[u8]) -> Result<Reply> {
        let to = to.to_lowercase();
        let hex = abi::hex_encode(data);
        if let Some(reply) = self.exact.get(&(to.clone(), hex.clone())) {
            return Ok(reply.clone());
        }
        if data.len() >= 4 {
            let selector = abi::hex_encode(&data[..4]);
            if let Some(reply) = self.by_selector.get(&(to.clone(), selector)) {
                return Ok(reply.clone());
            }
        }
        let mut known: Vec<String> = self
            .exact
            .keys()
            .map(|(t, d)| format!("{t} {d}"))
            .chain(
                self.by_selector
                    .keys()
                    .map(|(t, s)| format!("{t} {s} (any args)")),
            )
            .collect();
        known.sort();
        bail!(
            "MockRpc has no stub for {to} {hex}\nstubbed:\n  {}",
            if known.is_empty() {
                "(nothing)".to_string()
            } else {
                known.join("\n  ")
            }
        )
    }
}

impl EvmRpc for MockRpc {
    fn eth_call<'a>(&'a self, to: &'a str, data: &'a [u8]) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("mock call log poisoned")
                .push(RecordedCall {
                    to: to.to_lowercase(),
                    data: abi::hex_encode(data),
                });
            match self.lookup(to, data)? {
                Reply::Data(bytes) => Ok(bytes),
                Reply::Revert(message) => bail!("execution reverted: {message}"),
            }
        })
    }

    fn eth_get_balance<'a>(&'a self, address: &'a str) -> BoxFuture<'a, Result<U256>> {
        Box::pin(async move {
            self.balances
                .get(&address.to_lowercase())
                .copied()
                .ok_or_else(|| anyhow!("MockRpc has no balance stubbed for {address}"))
        })
    }

    fn label(&self) -> &str {
        "mock"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::Fields;
    use crate::http_cache::Mode;
    use std::sync::Arc;

    const NPM: &str = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
    const POOL: &str = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
    const OUTPUTS: &str =
        "uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128";

    /// A `positions()` return with a negative lower tick, as a real NPM would answer.
    fn positions_return() -> Vec<Value> {
        vec![
            Value::uint(0u64),
            Value::address("0x0000000000000000000000000000000000000000").unwrap(),
            Value::address("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2").unwrap(),
            Value::address("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48").unwrap(),
            Value::uint(3000u64),
            Value::int(-887_220),
            Value::int(-100),
            Value::uint(1_234_567_890_123_456_789_012_345u128),
            Value::uint(U256::MAX),
            Value::uint(U256::ONE.shl(128)),
            Value::uint(98_765_432_109_876_543_210u128),
            Value::uint(0u64),
        ]
    }

    #[tokio::test]
    async fn a_stubbed_positions_call_decodes_to_the_right_struct() {
        let rpc = MockRpc::new()
            .returns(
                NPM,
                "positions(uint256)",
                &[Value::uint(7u64)],
                &positions_return(),
            )
            .unwrap();

        let p = rpc
            .call_typed(NPM, "positions(uint256)", &[Value::uint(7u64)], OUTPUTS)
            .await
            .unwrap();

        assert_eq!(
            p.at(2).unwrap().as_address_string().unwrap(),
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "token0"
        );
        assert_eq!(p.at(4).unwrap().as_u64().unwrap(), 3000, "fee");
        assert_eq!(p.at(5).unwrap().as_i32().unwrap(), -887_220, "tickLower");
        assert_eq!(p.at(6).unwrap().as_i32().unwrap(), -100, "tickUpper");
        assert_eq!(
            p.at(7).unwrap().as_u128().unwrap(),
            1_234_567_890_123_456_789_012_345,
            "liquidity"
        );
        assert_eq!(p.at(8).unwrap().as_u256().unwrap(), U256::MAX);

        // The mock saw exactly the calldata a node would have.
        let calls = rpc.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].to, NPM.to_lowercase());
        assert!(calls[0].data.starts_with("0x99fbab88"), "{}", calls[0].data);
    }

    #[tokio::test]
    async fn call_one_unwraps_a_single_output() {
        let rpc = MockRpc::new()
            .returns(
                NPM,
                "balanceOf(address)",
                &[Value::address("0x1111111111111111111111111111111111111111").unwrap()],
                &[Value::uint(3u64)],
            )
            .unwrap();
        let n = rpc
            .call_one(
                NPM,
                "balanceOf(address)",
                &[Value::address("0x1111111111111111111111111111111111111111").unwrap()],
                "uint256",
            )
            .await
            .unwrap();
        assert_eq!(n.as_u64().unwrap(), 3);
    }

    #[tokio::test]
    async fn a_catch_all_stub_answers_any_arguments_but_an_exact_stub_wins() {
        let rpc = MockRpc::new()
            .returns_for_any_args(
                POOL,
                "slot0()",
                &[
                    Value::uint(U256::from_dec_str("79228162514264337593543950336").unwrap()),
                    Value::int(0),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::Bool(true),
                ],
            )
            .unwrap()
            .returns_for_any_args(NPM, "positions(uint256)", &positions_return())
            .unwrap()
            .returns(NPM, "positions(uint256)", &[Value::uint(9u64)], &{
                let mut special = positions_return();
                special[5] = Value::int(-42);
                special
            })
            .unwrap();

        let any = rpc
            .call_typed(NPM, "positions(uint256)", &[Value::uint(1u64)], OUTPUTS)
            .await
            .unwrap();
        assert_eq!(any.at(5).unwrap().as_i32().unwrap(), -887_220);

        let exact = rpc
            .call_typed(NPM, "positions(uint256)", &[Value::uint(9u64)], OUTPUTS)
            .await
            .unwrap();
        assert_eq!(
            exact.at(5).unwrap().as_i32().unwrap(),
            -42,
            "exact stub wins"
        );

        let slot0 = rpc
            .call_typed(
                POOL,
                "slot0()",
                &[],
                "uint160,int24,uint16,uint16,uint16,uint8,bool",
            )
            .await
            .unwrap();
        assert_eq!(slot0.at(1).unwrap().as_i32().unwrap(), 0);
    }

    #[tokio::test]
    async fn an_unstubbed_call_says_what_was_stubbed() {
        let rpc = MockRpc::new()
            .returns_for_any_args(NPM, "positions(uint256)", &positions_return())
            .unwrap();
        let err = rpc
            .call_typed(NPM, "slot0()", &[], "uint160")
            .await
            .unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("no stub for"), "{text}");
        assert!(text.contains("99fbab88"), "should list the stubs: {text}");
    }

    #[tokio::test]
    async fn a_revert_surfaces_as_an_error() {
        let rpc = MockRpc::new()
            .reverts(NPM, "positions(uint256)", "Invalid token ID")
            .unwrap();
        let err = rpc
            .call_typed(NPM, "positions(uint256)", &[Value::uint(1u64)], OUTPUTS)
            .await
            .unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("Invalid token ID"), "{text}");
    }

    #[tokio::test]
    async fn an_empty_return_is_reported_as_a_missing_contract() {
        // A v3 NPM address on a chain that does not have one: the node answers 0x.
        let rpc = MockRpc::new()
            .returns_nothing(NPM, "positions(uint256)")
            .unwrap();
        let err = rpc
            .call_typed(NPM, "positions(uint256)", &[Value::uint(1u64)], OUTPUTS)
            .await
            .unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("empty return data"), "{text}");
    }

    #[tokio::test]
    async fn balances_come_back_in_wei() {
        let addr = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
        let rpc = MockRpc::new().balance(addr, U256::from_dec_str("1234500000000000000").unwrap());
        let wei = rpc.eth_get_balance(addr).await.unwrap();
        assert_eq!(wei.to_string(), "1234500000000000000");
        // Scaling to a display figure is the caller's job, as in _rpc_native_balance.
        assert!((wei.as_f64() / 1e18 - 1.2345).abs() < 1e-12);
        // A different address is an error rather than a silent zero.
        assert!(rpc.eth_get_balance("0xdead").await.is_err());
    }

    #[tokio::test]
    async fn the_trait_is_object_safe() {
        let rpc: Arc<dyn EvmRpc> = Arc::new(
            MockRpc::new()
                .returns_for_any_args(NPM, "factory()", &[Value::address(POOL).unwrap()])
                .unwrap(),
        );
        // Through the trait object...
        let out = rpc
            .call_one(NPM, "factory()", &[], "address")
            .await
            .unwrap();
        assert_eq!(out.as_address_string().unwrap(), POOL);
        // ...and through an Arc held by a generic adapter.
        async fn generic<R: EvmRpc>(rpc: &R) -> Result<Value> {
            rpc.call_one(NPM, "factory()", &[], "address").await
        }
        assert!(generic(&rpc).await.is_ok());
    }

    // ---- the live client, against a local socket -------------------------

    /// Serve one canned JSON body to every request, recording the request bodies.
    async fn fake_node(body: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let sink = Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let sink = Arc::clone(&sink);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 8192];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Some((_, body)) = request.split_once("\r\n\r\n") {
                        sink.lock().unwrap().push(body.to_string());
                    }
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn passthrough(url: &str) -> HttpRpc {
        HttpRpc::new(
            reqwest::Client::new(),
            HttpCache::new(std::env::temp_dir().join("lyra-evm-unused"), Mode::Off),
            url,
            "test",
        )
    }

    #[tokio::test]
    async fn eth_call_sends_the_shape_the_oracle_sends_and_decodes_the_result() {
        let (url, seen) = fake_node(
            r#"{"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000000000000000000000000000000000000000000006"}"#,
        )
        .await;
        let rpc = passthrough(&url);

        let out = rpc
            .call_one(
                "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                "decimals()",
                &[],
                "uint8",
            )
            .await
            .unwrap();
        assert_eq!(out.as_u8().unwrap(), 6);

        let body: serde_json::Value = serde_json::from_str(&seen.lock().unwrap()[0]).unwrap();
        assert_eq!(body["method"], "eth_call");
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(
            body["params"][0]["to"],
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
        );
        assert_eq!(body["params"][0]["data"], "0x313ce567");
        assert_eq!(body["params"][1], "latest", "always the latest block");
    }

    #[tokio::test]
    async fn eth_get_balance_parses_a_hex_quantity() {
        let (url, seen) =
            fake_node(r#"{"jsonrpc":"2.0","id":1,"result":"0x1122334455667788990"}"#).await;
        let wei = passthrough(&url)
            .eth_get_balance("0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e")
            .await
            .unwrap();
        assert_eq!(wei, U256::from_hex("0x1122334455667788990").unwrap());

        let body: serde_json::Value = serde_json::from_str(&seen.lock().unwrap()[0]).unwrap();
        assert_eq!(body["method"], "eth_getBalance");
        assert_eq!(body["params"][1], "latest");
    }

    #[tokio::test]
    async fn a_json_rpc_error_becomes_an_error_with_the_revert_reason() {
        // The standard Error(string) payload: selector 0x08c379a0 + an ABI-encoded string.
        let data = {
            let mut d = abi::selector("Error(string)").unwrap().to_vec();
            d.extend_from_slice(&abi::encode(&[Value::String("Invalid token ID".into())]));
            abi::hex_encode(&d)
        };
        let body: &'static str = Box::leak(
            format!(
                r#"{{"jsonrpc":"2.0","id":1,"error":{{"code":3,"message":"execution reverted","data":"{data}"}}}}"#
            )
            .into_boxed_str(),
        );
        let (url, _) = fake_node(body).await;
        let err = passthrough(&url)
            .call_one(
                "0x0000000000000000000000000000000000000001",
                "decimals()",
                &[],
                "uint8",
            )
            .await
            .unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("execution reverted"), "{text}");
        assert!(text.contains("code 3"), "{text}");
        assert!(
            text.contains("Invalid token ID"),
            "the reason is decoded: {text}"
        );
    }

    #[tokio::test]
    async fn a_result_of_0x_becomes_the_empty_return_data_error() {
        let (url, _) = fake_node(r#"{"jsonrpc":"2.0","id":1,"result":"0x"}"#).await;
        let err = passthrough(&url)
            .call_one(
                "0x0000000000000000000000000000000000000001",
                "decimals()",
                &[],
                "uint8",
            )
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("empty return data"), "{err:#}");
    }

    #[tokio::test]
    async fn a_malformed_response_is_an_error_not_a_panic() {
        let (url, _) = fake_node("not json at all").await;
        assert!(
            passthrough(&url)
                .eth_get_balance("0x0000000000000000000000000000000000000001")
                .await
                .is_err()
        );

        let (url, _) = fake_node(r#"{"jsonrpc":"2.0","id":1}"#).await;
        let err = passthrough(&url)
            .eth_get_balance("0x0000000000000000000000000000000000000001")
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("no result"), "{err:#}");
    }

    #[tokio::test]
    async fn calls_go_through_the_http_cache_so_they_can_be_replayed() {
        let dir = tempfile::TempDir::new().unwrap();
        let (url, _) = fake_node(
            r#"{"jsonrpc":"2.0","id":1,"result":"0x0000000000000000000000000000000000000000000000000000000000000012"}"#,
        )
        .await;
        let token = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

        let recorder = HttpRpc::new(
            reqwest::Client::new(),
            HttpCache::new(dir.path(), Mode::Record),
            &url,
            "test",
        );
        let live = recorder
            .call_one(token, "decimals()", &[], "uint8")
            .await
            .unwrap();
        assert_eq!(live.as_u8().unwrap(), 18);

        // Replay against an unroutable URL would fail if it touched the network; it must not.
        let replayer = HttpRpc::new(
            reqwest::Client::new(),
            HttpCache::new(dir.path(), Mode::Replay),
            &url,
            "test",
        );
        let replayed = replayer
            .call_one(token, "decimals()", &[], "uint8")
            .await
            .unwrap();
        assert_eq!(replayed, live);

        // A call that was never recorded fails loudly rather than going live.
        let miss = replayer.call_one(token, "symbol()", &[], "string").await;
        assert!(miss.is_err(), "replay must not fall back to the network");
    }

    #[test]
    fn a_chain_without_an_rpc_is_rejected_up_front() {
        let cache = HttpCache::new(std::env::temp_dir().join("lyra-evm-unused"), Mode::Off);
        let client = reqwest::Client::new();
        for chain in crate::chains::all() {
            let built = HttpRpc::for_chain(client.clone(), cache.clone(), chain);
            assert_eq!(
                built.is_ok(),
                chain.rpc.is_some(),
                "{} rpc={:?}",
                chain.name,
                chain.rpc
            );
            if let Ok(rpc) = built {
                assert_eq!(rpc.label(), chain.name);
                assert_eq!(rpc.url(), chain.rpc.unwrap());
            }
        }
    }
}
