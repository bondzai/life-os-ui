//! Ethereum ABI: 256-bit integers, keccak-256, and the encode/decode the DeFi adapters need.
//!
//! This replaces what `portfolio.py` gets from `web3.py` + `eth_abi`. It is hand-rolled rather
//! than pulled from `alloy`: the surface the port actually uses is small (the types in
//! `NPM_ABI`, `POOL_ABI`, `V4_SV_ABI`, `AAVE_DATA_PROVIDER_ABI` and friends), the crate already
//! hand-rolls 256-bit work in [`crate::lp_math`], and a self-contained codec keeps the build
//! free of a large dependency tree for a read-only portfolio reader.
//!
//! # For adapter authors
//!
//! You will mostly touch four things:
//!
//! ```no_run
//! # use lyra_chain::abi::{self, Value, U256};
//! # fn f() -> anyhow::Result<()> {
//! // 1. Build calldata from a signature. Widths are checked against the signature.
//! let data = abi::encode_call("positions(uint256)", &[Value::uint(12345u64)])?;
//!
//! // 2. Decode a return blob against a type list, written exactly like the Solidity outputs.
//! let out = abi::decode(
//!     "uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128",
//!     &[0u8; 384],
//! )?;
//!
//! // 3. Pull typed fields out. `as_i32` only works on a value decoded as `intN`.
//! use abi::Fields;
//! let tick_lower = out.at(5)?.as_i32()?;
//! let liquidity = out.at(7)?.as_u128()?;
//! let fee_growth: U256 = out.at(8)?.as_u256()?;
//! # Ok(()) }
//! ```
//!
//! # The sign-extension trap
//!
//! A `int24` tick comes back as a full 32-byte word, sign-extended by the contract: tick `-887220`
//! is `0xfff…f276 4c`, not `0x…f2764c`. Read that word as an unsigned integer and you get
//! ~1.15e77 instead of a small negative number, and every price derived from it is astronomically
//! wrong — silently, because nothing overflows.
//!
//! The guard here is the type list you pass to [`decode`]. Declaring a field `int24` produces
//! [`Value::Int`], which is the only variant [`Value::as_i32`] accepts; declaring it `uint24`
//! produces [`Value::Uint`], where `as_i32` refuses rather than handing back a wrong number.
//! **Never reach for `as_u256().low_u64() as i32` on a tick.** Decoding also rejects a word whose
//! high bits disagree with the declared width, so a `uint24` field can never quietly hold a
//! negative tick.

use anyhow::{Context, Result, anyhow, bail};
use std::fmt;
use std::str::FromStr;

/// One ABI word.
pub const WORD: usize = 32;

// ===========================================================================
// U256
// ===========================================================================

/// A 256-bit unsigned integer — the width of an ABI word.
///
/// Exists because on-chain values routinely exceed `u128`: `sqrtPriceX96` is a `uint160`,
/// `feeGrowthGlobal0X128` is a full `uint256`, and Aave reports `type(uint256).max` as
/// "no debt". Arithmetic is explicit (`wrapping_*` / `checked_*`) so a port of Python's
/// arbitrary-precision maths has to say which behaviour it means; `wrapping_sub` is the
/// direct equivalent of the oracle's `(a - b) & U256`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct U256 {
    /// Little-endian: `limbs[0]` is the least significant 64 bits.
    limbs: [u64; 4],
}

impl U256 {
    pub const ZERO: U256 = U256 { limbs: [0; 4] };
    pub const ONE: U256 = U256 {
        limbs: [1, 0, 0, 0],
    };
    pub const MAX: U256 = U256 {
        limbs: [u64::MAX; 4],
    };

    #[must_use]
    pub const fn from_u64(v: u64) -> Self {
        U256 {
            limbs: [v, 0, 0, 0],
        }
    }

    #[must_use]
    pub const fn from_u128(v: u128) -> Self {
        U256 {
            limbs: [v as u64, (v >> 64) as u64, 0, 0],
        }
    }

    #[must_use]
    pub const fn from_be_bytes(bytes: [u8; 32]) -> Self {
        let mut limbs = [0u64; 4];
        let mut i = 0;
        while i < 4 {
            let s = 24 - i * 8;
            limbs[i] = u64::from_be_bytes([
                bytes[s],
                bytes[s + 1],
                bytes[s + 2],
                bytes[s + 3],
                bytes[s + 4],
                bytes[s + 5],
                bytes[s + 6],
                bytes[s + 7],
            ]);
            i += 1;
        }
        U256 { limbs }
    }

    #[must_use]
    pub fn to_be_bytes(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, limb) in self.limbs.iter().enumerate() {
            let s = 24 - i * 8;
            out[s..s + 8].copy_from_slice(&limb.to_be_bytes());
        }
        out
    }

    /// Parse hex, with or without a `0x` prefix, of any length up to 64 nibbles.
    pub fn from_hex(s: &str) -> Result<Self> {
        let s = s
            .strip_prefix("0x")
            .or_else(|| s.strip_prefix("0X"))
            .unwrap_or(s);
        if s.is_empty() {
            bail!("empty hex string");
        }
        if s.len() > 64 {
            bail!("hex value wider than 256 bits: {s}");
        }
        let mut limbs = [0u64; 4];
        for (i, ch) in s.chars().rev().enumerate() {
            let d = ch
                .to_digit(16)
                .ok_or_else(|| anyhow!("invalid hex digit {ch:?} in {s:?}"))?;
            limbs[i / 16] |= u64::from(d) << ((i % 16) * 4);
        }
        Ok(U256 { limbs })
    }

    /// Parse a base-10 string. Rejects overflow rather than wrapping.
    pub fn from_dec_str(s: &str) -> Result<Self> {
        if s.is_empty() {
            bail!("empty decimal string");
        }
        let mut acc = U256::ZERO;
        for ch in s.chars() {
            let d = ch
                .to_digit(10)
                .ok_or_else(|| anyhow!("invalid decimal digit {ch:?} in {s:?}"))?;
            acc = acc
                .checked_mul(U256::from_u64(10))
                .and_then(|v| v.checked_add(U256::from_u64(u64::from(d))))
                .ok_or_else(|| anyhow!("decimal value overflows 256 bits: {s}"))?;
        }
        Ok(acc)
    }

    /// `0x`-prefixed, minimal-width hex — the shape a JSON-RPC quantity takes.
    #[must_use]
    pub fn to_hex(self) -> String {
        format!("{self:#x}")
    }

    /// `0x`-prefixed, zero-padded to a full 32-byte word.
    #[must_use]
    pub fn to_hex_padded(self) -> String {
        format!("0x{}", hex_encode_bare(&self.to_be_bytes()))
    }

    #[must_use]
    pub fn is_zero(self) -> bool {
        self.limbs == [0; 4]
    }

    /// Bit `i` (0 = least significant). Bits at or above 256 read as `false`.
    #[must_use]
    pub fn bit(self, i: u32) -> bool {
        if i >= 256 {
            return false;
        }
        self.limbs[(i / 64) as usize] >> (i % 64) & 1 == 1
    }

    /// Number of significant bits — 0 for zero.
    #[must_use]
    pub fn bits(self) -> u32 {
        for i in (0..4).rev() {
            if self.limbs[i] != 0 {
                return (i as u32 + 1) * 64 - self.limbs[i].leading_zeros();
            }
        }
        0
    }

    /// The low 64 bits, discarding anything above. Use [`U256::try_to_u64`] when truncation
    /// would be a bug.
    #[must_use]
    pub fn low_u64(self) -> u64 {
        self.limbs[0]
    }

    /// The low 128 bits, discarding anything above.
    #[must_use]
    pub fn low_u128(self) -> u128 {
        u128::from(self.limbs[0]) | u128::from(self.limbs[1]) << 64
    }

    pub fn try_to_u64(self) -> Result<u64> {
        if self.limbs[1..] != [0; 3] {
            bail!("{self} does not fit in u64");
        }
        Ok(self.limbs[0])
    }

    pub fn try_to_u128(self) -> Result<u128> {
        if self.limbs[2..] != [0; 2] {
            bail!("{self} does not fit in u128");
        }
        Ok(self.low_u128())
    }

    /// Nearest `f64`. Lossy above 2^53, which is fine for the display maths the port does
    /// (see [`crate::lp_math`]) and wrong for anything that must stay exact.
    #[must_use]
    pub fn as_f64(self) -> f64 {
        let mut out = 0.0f64;
        for limb in self.limbs.iter().rev() {
            out = out * 18_446_744_073_709_551_616.0 + *limb as f64;
        }
        out
    }

    #[must_use]
    pub fn wrapping_add(self, rhs: Self) -> Self {
        let mut limbs = [0u64; 4];
        let mut carry = 0u64;
        for ((out, a), b) in limbs.iter_mut().zip(self.limbs).zip(rhs.limbs) {
            let (sum, c1) = a.overflowing_add(b);
            let (sum, c2) = sum.overflowing_add(carry);
            *out = sum;
            carry = u64::from(c1) + u64::from(c2);
        }
        U256 { limbs }
    }

    /// Wrapping subtraction — the direct equivalent of the oracle's `(a - b) & U256`, which is
    /// how Uniswap fee-growth deltas are meant to be computed (they legitimately underflow).
    #[must_use]
    pub fn wrapping_sub(self, rhs: Self) -> Self {
        let mut limbs = [0u64; 4];
        let mut borrow = 0u64;
        for ((out, a), b) in limbs.iter_mut().zip(self.limbs).zip(rhs.limbs) {
            let (diff, b1) = a.overflowing_sub(b);
            let (diff, b2) = diff.overflowing_sub(borrow);
            *out = diff;
            borrow = u64::from(b1) + u64::from(b2);
        }
        U256 { limbs }
    }

    #[must_use]
    pub fn wrapping_mul(self, rhs: Self) -> Self {
        let full = self.full_mul(rhs);
        U256 {
            limbs: [full[0], full[1], full[2], full[3]],
        }
    }

    #[must_use]
    pub fn checked_add(self, rhs: Self) -> Option<Self> {
        let out = self.wrapping_add(rhs);
        if out < self { None } else { Some(out) }
    }

    #[must_use]
    pub fn checked_sub(self, rhs: Self) -> Option<Self> {
        if rhs > self {
            None
        } else {
            Some(self.wrapping_sub(rhs))
        }
    }

    #[must_use]
    pub fn checked_mul(self, rhs: Self) -> Option<Self> {
        let full = self.full_mul(rhs);
        if full[4..] != [0; 4] {
            return None;
        }
        Some(U256 {
            limbs: [full[0], full[1], full[2], full[3]],
        })
    }

    /// The full 512-bit product, little-endian limbs.
    #[must_use]
    pub fn full_mul(self, rhs: Self) -> [u64; 8] {
        let mut out = [0u64; 8];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                let cur = u128::from(out[i + j])
                    + u128::from(self.limbs[i]) * u128::from(rhs.limbs[j])
                    + carry;
                out[i + j] = cur as u64;
                carry = cur >> 64;
            }
            let mut k = i + 4;
            while carry != 0 && k < 8 {
                let cur = u128::from(out[k]) + carry;
                out[k] = cur as u64;
                carry = cur >> 64;
                k += 1;
            }
        }
        out
    }

    /// `(self * rhs) >> shift`, computed at full 512-bit width — the shape of Uniswap's fee
    /// maths (`liquidity * feeGrowthDelta >> 128`), where the intermediate product genuinely
    /// exceeds 256 bits even though the result fits. `None` if the *result* does not fit.
    #[must_use]
    pub fn mul_shr(self, rhs: Self, shift: u32) -> Option<Self> {
        let full = self.full_mul(rhs);
        let shifted = shr_512(full, shift);
        if shifted[4..] != [0; 4] {
            return None;
        }
        Some(U256 {
            limbs: [shifted[0], shifted[1], shifted[2], shifted[3]],
        })
    }

    /// Shift left by a *bit count*, discarding bits shifted out of the top.
    // Named `shl` for familiarity even though it takes a `u32` rather than a `Self`; the
    // `Shl<u32>` operator impl below delegates here.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn shl(self, n: u32) -> Self {
        if n >= 256 {
            return U256::ZERO;
        }
        let (words, bits) = ((n / 64) as usize, n % 64);
        let mut limbs = [0u64; 4];
        for (i, out) in limbs.iter_mut().enumerate().rev() {
            if i < words {
                break;
            }
            let mut v = self.limbs[i - words] << bits;
            if bits > 0 && i > words {
                v |= self.limbs[i - words - 1] >> (64 - bits);
            }
            *out = v;
        }
        U256 { limbs }
    }

    /// Shift right by a *bit count*, discarding bits shifted out of the bottom.
    #[allow(clippy::should_implement_trait)]
    #[must_use]
    pub fn shr(self, n: u32) -> Self {
        if n >= 256 {
            return U256::ZERO;
        }
        let (words, bits) = ((n / 64) as usize, n % 64);
        let mut limbs = [0u64; 4];
        for (i, out) in limbs.iter_mut().enumerate() {
            if i + words >= 4 {
                break;
            }
            let mut v = self.limbs[i + words] >> bits;
            if bits > 0 && i + words + 1 < 4 {
                v |= self.limbs[i + words + 1] << (64 - bits);
            }
            *out = v;
        }
        U256 { limbs }
    }

    /// Quotient and remainder against a small divisor — enough for decimal formatting and
    /// for scaling raw amounts by a token's decimals.
    pub fn div_mod_u64(self, d: u64) -> Result<(Self, u64)> {
        if d == 0 {
            bail!("division by zero");
        }
        let mut q = [0u64; 4];
        let mut rem = 0u128;
        for i in (0..4).rev() {
            let cur = (rem << 64) | u128::from(self.limbs[i]);
            q[i] = (cur / u128::from(d)) as u64;
            rem = cur % u128::from(d);
        }
        Ok((U256 { limbs: q }, rem as u64))
    }
}

fn shr_512(v: [u64; 8], n: u32) -> [u64; 8] {
    let (words, bits) = ((n / 64) as usize, n % 64);
    if words >= 8 {
        return [0; 8];
    }
    let mut out = [0u64; 8];
    for i in 0..8 - words {
        let mut x = v[i + words] >> bits;
        if bits > 0 && i + words + 1 < 8 {
            x |= v[i + words + 1] << (64 - bits);
        }
        out[i] = x;
    }
    out
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Most significant limb first — the derived order would compare the *least* significant.
        for i in (0..4).rev() {
            match self.limbs[i].cmp(&other.limbs[i]) {
                std::cmp::Ordering::Equal => {}
                ord => return ord,
            }
        }
        std::cmp::Ordering::Equal
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for U256 {
    /// Base 10, so a value can be compared against the Python oracle's `int` verbatim.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_zero() {
            return f.write_str("0");
        }
        // 10^19 is the largest power of ten inside u64.
        const CHUNK: u64 = 10_000_000_000_000_000_000;
        let mut parts: Vec<u64> = Vec::new();
        let mut cur = *self;
        while !cur.is_zero() {
            let (q, r) = cur.div_mod_u64(CHUNK).expect("nonzero divisor");
            parts.push(r);
            cur = q;
        }
        let mut out = parts.pop().expect("nonzero value has a chunk").to_string();
        while let Some(p) = parts.pop() {
            out.push_str(&format!("{p:019}"));
        }
        f.write_str(&out)
    }
}

impl fmt::Debug for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self}")
    }
}

impl fmt::LowerHex for U256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let bytes = self.to_be_bytes();
        let first = bytes.iter().position(|b| *b != 0).unwrap_or(31);
        let mut s = String::new();
        for (i, b) in bytes[first..].iter().enumerate() {
            if i == 0 {
                s.push_str(&format!("{b:x}"));
            } else {
                s.push_str(&format!("{b:02x}"));
            }
        }
        if f.alternate() {
            write!(f, "0x{s}")
        } else {
            write!(f, "{s}")
        }
    }
}

impl FromStr for U256 {
    type Err = anyhow::Error;

    /// `0x…` is hex, anything else decimal.
    fn from_str(s: &str) -> Result<Self> {
        if s.starts_with("0x") || s.starts_with("0X") {
            U256::from_hex(s)
        } else {
            U256::from_dec_str(s)
        }
    }
}

impl From<u64> for U256 {
    fn from(v: u64) -> Self {
        U256::from_u64(v)
    }
}

impl From<u128> for U256 {
    fn from(v: u128) -> Self {
        U256::from_u128(v)
    }
}

impl From<u32> for U256 {
    fn from(v: u32) -> Self {
        U256::from_u64(u64::from(v))
    }
}

impl std::ops::BitAnd for U256 {
    type Output = U256;
    fn bitand(self, rhs: Self) -> U256 {
        let mut limbs = [0u64; 4];
        for ((out, a), b) in limbs.iter_mut().zip(self.limbs).zip(rhs.limbs) {
            *out = a & b;
        }
        U256 { limbs }
    }
}

impl std::ops::BitOr for U256 {
    type Output = U256;
    fn bitor(self, rhs: Self) -> U256 {
        let mut limbs = [0u64; 4];
        for ((out, a), b) in limbs.iter_mut().zip(self.limbs).zip(rhs.limbs) {
            *out = a | b;
        }
        U256 { limbs }
    }
}

impl std::ops::Not for U256 {
    type Output = U256;
    fn not(self) -> U256 {
        let mut limbs = [0u64; 4];
        for (out, a) in limbs.iter_mut().zip(self.limbs) {
            *out = !a;
        }
        U256 { limbs }
    }
}

impl std::ops::Shl<u32> for U256 {
    type Output = U256;
    fn shl(self, n: u32) -> U256 {
        U256::shl(self, n)
    }
}

impl std::ops::Shr<u32> for U256 {
    type Output = U256;
    fn shr(self, n: u32) -> U256 {
        U256::shr(self, n)
    }
}

// ===========================================================================
// Signed words
// ===========================================================================

/// Sign-extend the low `bits` of a word to the full 256 bits.
///
/// This is what makes a negative tick survive: `0x…f2764c` read as 24 bits is `-887220`, and
/// the extension turns it into the `0xfff…f2764c` word that means the same thing at 256 bits.
#[must_use]
pub fn sign_extend(word: U256, bits: u32) -> U256 {
    if bits == 0 || bits >= 256 || !word.bit(bits - 1) {
        return word;
    }
    let mask = U256::MAX.shl(bits);
    word | mask
}

/// Interpret a word as a two's-complement `int256` and narrow it to `i128`.
pub fn i128_from_word(word: U256) -> Result<i128> {
    if word.bit(255) {
        let magnitude = (!word).wrapping_add(U256::ONE);
        let m = magnitude
            .try_to_u128()
            .with_context(|| format!("signed word {word:#x} is too negative for i128"))?;
        if m > 1 << 127 {
            bail!("signed word {word:#x} is too negative for i128");
        }
        Ok((m as i128).wrapping_neg())
    } else {
        let m = word
            .try_to_u128()
            .with_context(|| format!("signed word {word:#x} is too large for i128"))?;
        i128::try_from(m).map_err(|_| anyhow!("signed word {word:#x} is too large for i128"))
    }
}

/// The two's-complement word for a signed value — how a negative tick is passed as calldata.
#[must_use]
pub fn word_from_i128(v: i128) -> U256 {
    if v < 0 {
        // -x == !x + 1 over 256 bits
        (!U256::from_u128(v.unsigned_abs())).wrapping_add(U256::ONE)
    } else {
        U256::from_u128(v as u128)
    }
}

// ===========================================================================
// keccak-256
// ===========================================================================

const KECCAK_RC: [u64; 24] = [
    0x0000_0000_0000_0001,
    0x0000_0000_0000_8082,
    0x8000_0000_0000_808a,
    0x8000_0000_8000_8000,
    0x0000_0000_0000_808b,
    0x0000_0000_8000_0001,
    0x8000_0000_8000_8081,
    0x8000_0000_0000_8009,
    0x0000_0000_0000_008a,
    0x0000_0000_0000_0088,
    0x0000_0000_8000_8009,
    0x0000_0000_8000_000a,
    0x0000_0000_8000_808b,
    0x8000_0000_0000_008b,
    0x8000_0000_0000_8089,
    0x8000_0000_0000_8003,
    0x8000_0000_0000_8002,
    0x8000_0000_0000_0080,
    0x0000_0000_0000_800a,
    0x8000_0000_8000_000a,
    0x8000_0000_8000_8081,
    0x8000_0000_0000_8080,
    0x0000_0000_8000_0001,
    0x8000_0000_8000_8008,
];

const KECCAK_ROT: [u32; 24] = [
    1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];

const KECCAK_PI: [usize; 24] = [
    10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

#[allow(clippy::needless_range_loop)]
fn keccak_f(state: &mut [u64; 25]) {
    for round in KECCAK_RC {
        let mut bc = [0u64; 5];
        for i in 0..5 {
            bc[i] = state[i] ^ state[i + 5] ^ state[i + 10] ^ state[i + 15] ^ state[i + 20];
        }
        for i in 0..5 {
            let t = bc[(i + 4) % 5] ^ bc[(i + 1) % 5].rotate_left(1);
            for j in (0..25).step_by(5) {
                state[j + i] ^= t;
            }
        }
        let mut t = state[1];
        for i in 0..24 {
            let j = KECCAK_PI[i];
            let tmp = state[j];
            state[j] = t.rotate_left(KECCAK_ROT[i]);
            t = tmp;
        }
        for j in (0..25).step_by(5) {
            bc.copy_from_slice(&state[j..j + 5]);
            for i in 0..5 {
                state[j + i] ^= !bc[(i + 1) % 5] & bc[(i + 2) % 5];
            }
        }
        state[0] ^= round;
    }
}

/// keccak-256 — Ethereum's hash (the pre-NIST padding, *not* SHA3-256).
///
/// Used for function selectors, for the Uniswap v4 pool id (`keccak(abi.encode(poolKey))`) and
/// for the v4 position id (`keccak(abi.encodePacked(...))`).
#[must_use]
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    const RATE: usize = 136;
    let mut state = [0u64; 25];
    let absorb = |block: &[u8; RATE], state: &mut [u64; 25]| {
        for (i, chunk) in block.chunks_exact(8).enumerate() {
            state[i] ^= u64::from_le_bytes(chunk.try_into().expect("8 bytes"));
        }
        keccak_f(state);
    };

    let mut chunks = data.chunks_exact(RATE);
    for chunk in chunks.by_ref() {
        absorb(chunk.try_into().expect("rate-sized block"), &mut state);
    }
    let rest = chunks.remainder();
    let mut last = [0u8; RATE];
    last[..rest.len()].copy_from_slice(rest);
    last[rest.len()] = 0x01;
    last[RATE - 1] |= 0x80;
    absorb(&last, &mut state);

    let mut out = [0u8; 32];
    for (i, lane) in state[..4].iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&lane.to_le_bytes());
    }
    out
}

// ===========================================================================
// Address
// ===========================================================================

/// A 20-byte EVM address. [`fmt::Display`] is lowercase `0x…`; use [`Address::to_checksum`]
/// for the EIP-55 mixed-case form the Python oracle passes to nodes.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default, PartialOrd, Ord)]
pub struct Address(pub [u8; 20]);

impl Address {
    pub const ZERO: Address = Address([0u8; 20]);

    pub fn from_hex(s: &str) -> Result<Self> {
        let bytes = hex_decode(s).with_context(|| format!("address {s:?}"))?;
        let bytes: [u8; 20] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("address must be 20 bytes, got {} in {s:?}", bytes.len()))?;
        Ok(Address(bytes))
    }

    #[must_use]
    pub fn is_zero(&self) -> bool {
        self.0 == [0u8; 20]
    }

    /// EIP-55 checksummed form.
    #[must_use]
    pub fn to_checksum(&self) -> String {
        let lower = hex_encode_bare(&self.0);
        let hash = keccak256(lower.as_bytes());
        let mut out = String::with_capacity(42);
        out.push_str("0x");
        for (i, ch) in lower.chars().enumerate() {
            let nibble = if i % 2 == 0 {
                hash[i / 2] >> 4
            } else {
                hash[i / 2] & 0x0f
            };
            if ch.is_ascii_digit() || nibble < 8 {
                out.push(ch);
            } else {
                out.push(ch.to_ascii_uppercase());
            }
        }
        out
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "0x{}", hex_encode_bare(&self.0))
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self}")
    }
}

impl FromStr for Address {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        Address::from_hex(s)
    }
}

// ===========================================================================
// Hex helpers
// ===========================================================================

/// Decode hex with an optional `0x` prefix. An odd digit count is an error, not a guess.
pub fn hex_decode(s: &str) -> Result<Vec<u8>> {
    let s = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    if !s.len().is_multiple_of(2) {
        bail!("hex string has an odd number of digits ({} chars)", s.len());
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char)
            .to_digit(16)
            .ok_or_else(|| anyhow!("invalid hex digit {:?}", pair[0] as char))?;
        let lo = (pair[1] as char)
            .to_digit(16)
            .ok_or_else(|| anyhow!("invalid hex digit {:?}", pair[1] as char))?;
        out.push((hi * 16 + lo) as u8);
    }
    Ok(out)
}

/// `0x`-prefixed lowercase hex.
#[must_use]
pub fn hex_encode(bytes: &[u8]) -> String {
    format!("0x{}", hex_encode_bare(bytes))
}

fn hex_encode_bare(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

// ===========================================================================
// Types
// ===========================================================================

/// An ABI type, as written in a Solidity signature.
///
/// Build one with [`Type::parse`] (`"int24"`, `"(address,uint24)[]"`) or a whole output list
/// with [`Type::parse_list`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Type {
    Address,
    Bool,
    String,
    Bytes,
    /// `uintN`, N in 8..=256 and a multiple of 8.
    Uint(u16),
    /// `intN`, N in 8..=256 and a multiple of 8.
    Int(u16),
    /// `bytesN`, N in 1..=32.
    FixedBytes(u8),
    Tuple(Vec<Type>),
    /// `T[]`
    Array(Box<Type>),
    /// `T[N]`
    FixedArray(Box<Type>, usize),
}

impl Type {
    /// Parse a single type. Accepts the Solidity aliases `uint`/`int`/`byte`.
    pub fn parse(s: &str) -> Result<Type> {
        let s = s.trim();
        let (base, suffix) = split_array_suffix(s)?;
        let mut ty = Type::parse_base(base)?;
        // Suffixes bind left-to-right in the source text (`uint[2][3]` is 3 arrays of 2), which
        // means the *last* suffix is the outermost type.
        for dim in suffix {
            ty = match dim {
                None => Type::Array(Box::new(ty)),
                Some(n) => Type::FixedArray(Box::new(ty), n),
            };
        }
        Ok(ty)
    }

    fn parse_base(s: &str) -> Result<Type> {
        let s = s.trim();
        if let Some(inner) = s.strip_prefix('(') {
            let inner = inner
                .strip_suffix(')')
                .ok_or_else(|| anyhow!("unbalanced parentheses in type {s:?}"))?;
            return Ok(Type::Tuple(Type::parse_list(inner)?));
        }
        // `tuple(...)` — the JSON-ABI spelling that also shows up in signatures.
        if let Some(inner) = s.strip_prefix("tuple(") {
            let inner = inner
                .strip_suffix(')')
                .ok_or_else(|| anyhow!("unbalanced parentheses in type {s:?}"))?;
            return Ok(Type::Tuple(Type::parse_list(inner)?));
        }
        // A trailing parameter name ("uint256 tokenId") is tolerated so a signature can be
        // pasted straight out of an ABI.
        let s = s.split_whitespace().next().unwrap_or(s);
        Ok(match s {
            "address" => Type::Address,
            "bool" => Type::Bool,
            "string" => Type::String,
            "bytes" => Type::Bytes,
            "uint" => Type::Uint(256),
            "int" => Type::Int(256),
            "byte" => Type::FixedBytes(1),
            _ => {
                if let Some(n) = s.strip_prefix("uint") {
                    Type::Uint(parse_int_width(n, s)?)
                } else if let Some(n) = s.strip_prefix("int") {
                    Type::Int(parse_int_width(n, s)?)
                } else if let Some(n) = s.strip_prefix("bytes") {
                    let n: u8 = n.parse().map_err(|_| anyhow!("bad type {s:?}"))?;
                    if n == 0 || n > 32 {
                        bail!("bytesN must have 1..=32 bytes, got {s:?}");
                    }
                    Type::FixedBytes(n)
                } else {
                    bail!("unsupported ABI type {s:?}");
                }
            }
        })
    }

    /// Parse a comma-separated list, e.g. an outputs list. An empty string is an empty list.
    pub fn parse_list(s: &str) -> Result<Vec<Type>> {
        let s = s.trim();
        if s.is_empty() {
            return Ok(Vec::new());
        }
        split_top_level(s)?
            .into_iter()
            .map(|part| Type::parse(&part))
            .collect()
    }

    /// Whether the type occupies an offset in the head rather than its value.
    #[must_use]
    pub fn is_dynamic(&self) -> bool {
        match self {
            Type::String | Type::Bytes | Type::Array(_) => true,
            Type::Tuple(inner) => inner.iter().any(Type::is_dynamic),
            Type::FixedArray(inner, n) => *n > 0 && inner.is_dynamic(),
            _ => false,
        }
    }

    /// Words this type occupies in a head when it is static.
    #[must_use]
    pub fn head_words(&self) -> usize {
        if self.is_dynamic() {
            return 1;
        }
        match self {
            Type::Tuple(inner) => inner.iter().map(Type::head_words).sum(),
            Type::FixedArray(inner, n) => inner.head_words() * n,
            _ => 1,
        }
    }

    /// The canonical spelling used when hashing a function signature.
    #[must_use]
    pub fn canonical(&self) -> String {
        match self {
            Type::Address => "address".into(),
            Type::Bool => "bool".into(),
            Type::String => "string".into(),
            Type::Bytes => "bytes".into(),
            Type::Uint(n) => format!("uint{n}"),
            Type::Int(n) => format!("int{n}"),
            Type::FixedBytes(n) => format!("bytes{n}"),
            Type::Tuple(inner) => {
                let parts: Vec<String> = inner.iter().map(Type::canonical).collect();
                format!("({})", parts.join(","))
            }
            Type::Array(inner) => format!("{}[]", inner.canonical()),
            Type::FixedArray(inner, n) => format!("{}[{n}]", inner.canonical()),
        }
    }
}

fn parse_int_width(digits: &str, whole: &str) -> Result<u16> {
    let n: u16 = digits.parse().map_err(|_| anyhow!("bad type {whole:?}"))?;
    if n == 0 || n > 256 || !n.is_multiple_of(8) {
        bail!("integer width must be 8..=256 and a multiple of 8, got {whole:?}");
    }
    Ok(n)
}

/// Split trailing `[]` / `[N]` groups off a type, innermost first.
fn split_array_suffix(s: &str) -> Result<(&str, Vec<Option<usize>>)> {
    let bytes = s.as_bytes();
    let mut end = s.len();
    let mut dims = Vec::new();
    while end > 0 && bytes[end - 1] == b']' {
        let open = s[..end - 1]
            .rfind('[')
            .ok_or_else(|| anyhow!("unbalanced brackets in type {s:?}"))?;
        let inner = s[open + 1..end - 1].trim();
        dims.push(if inner.is_empty() {
            None
        } else {
            Some(
                inner
                    .parse::<usize>()
                    .map_err(|_| anyhow!("bad array length in type {s:?}"))?,
            )
        });
        end = open;
    }
    dims.reverse();
    Ok((&s[..end], dims))
}

/// Split on commas that are not inside parentheses or brackets.
fn split_top_level(s: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for ch in s.chars() {
        match ch {
            '(' | '[' => {
                depth += 1;
                cur.push(ch);
            }
            ')' | ']' => {
                depth -= 1;
                if depth < 0 {
                    bail!("unbalanced brackets in type list {s:?}");
                }
                cur.push(ch);
            }
            ',' if depth == 0 => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(ch),
        }
    }
    if depth != 0 {
        bail!("unbalanced brackets in type list {s:?}");
    }
    out.push(cur);
    Ok(out)
}

// ===========================================================================
// Values
// ===========================================================================

/// A decoded (or to-be-encoded) ABI value.
///
/// The split between [`Value::Uint`] and [`Value::Int`] is deliberate and is the port's guard
/// against reading a negative tick as an enormous positive number: only `Int` answers
/// [`Value::as_i32`] / [`Value::as_i128`], and only `Uint` answers [`Value::as_u128`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Address(Address),
    Bool(bool),
    String(String),
    Bytes(Vec<u8>),
    /// Any `uintN`, zero-extended to a full word.
    Uint(U256),
    /// Any `intN`, held as its two's-complement word already sign-extended to 256 bits.
    Int(U256),
    /// `bytesN`, exactly N bytes.
    FixedBytes(Vec<u8>),
    Tuple(Vec<Value>),
    /// Both `T[]` and `T[N]` decode to this; it always *encodes* as `T[]`.
    Array(Vec<Value>),
}

impl Value {
    /// A `uintN` value.
    pub fn uint(v: impl Into<U256>) -> Value {
        Value::Uint(v.into())
    }

    /// An `intN` value from a signed number — sign extension is applied here, so a negative
    /// tick becomes the word a contract expects.
    pub fn int(v: i128) -> Value {
        Value::Int(word_from_i128(v))
    }

    /// An address from a `0x…` string, as chain config and Blockscout hand them over.
    pub fn address(s: &str) -> Result<Value> {
        Ok(Value::Address(Address::from_hex(s)?))
    }

    /// A `bytes32` from a 32-byte value.
    #[must_use]
    pub fn bytes32(b: [u8; 32]) -> Value {
        Value::FixedBytes(b.to_vec())
    }

    fn kind(&self) -> &'static str {
        match self {
            Value::Address(_) => "address",
            Value::Bool(_) => "bool",
            Value::String(_) => "string",
            Value::Bytes(_) => "bytes",
            Value::Uint(_) => "uint",
            Value::Int(_) => "int",
            Value::FixedBytes(_) => "bytesN",
            Value::Tuple(_) => "tuple",
            Value::Array(_) => "array",
        }
    }

    /// The raw 256-bit word of a `uintN` or `intN`. For a negative `intN` this is the
    /// two's-complement word (a huge number if you treat it as unsigned) — use
    /// [`Value::as_i128`] when the field is signed.
    pub fn as_u256(&self) -> Result<U256> {
        match self {
            Value::Uint(v) | Value::Int(v) => Ok(*v),
            other => bail!("expected an integer, got {}", other.kind()),
        }
    }

    /// A `uintN` narrowed to `u128` — `liquidity`, `tokensOwed`, and similar.
    pub fn as_u128(&self) -> Result<u128> {
        match self {
            Value::Uint(v) => v.try_to_u128(),
            Value::Int(_) => bail!("value is signed; use as_i128 (or decode it as uintN)"),
            other => bail!("expected uintN, got {}", other.kind()),
        }
    }

    pub fn as_u64(&self) -> Result<u64> {
        match self {
            Value::Uint(v) => v.try_to_u64(),
            Value::Int(_) => bail!("value is signed; use as_i128 (or decode it as uintN)"),
            other => bail!("expected uintN, got {}", other.kind()),
        }
    }

    /// A `uintN` narrowed to `u8` — `decimals()`.
    pub fn as_u8(&self) -> Result<u8> {
        let v = self.as_u64()?;
        u8::try_from(v).map_err(|_| anyhow!("{v} does not fit in u8"))
    }

    /// A signed field as `i128`.
    ///
    /// Refuses a [`Value::Uint`]: if the field really is signed, decode it as `intN` so the
    /// sign survives, rather than converting after the fact.
    pub fn as_i128(&self) -> Result<i128> {
        match self {
            Value::Int(v) => i128_from_word(*v),
            Value::Uint(_) => {
                bail!("value was decoded as uintN; decode it as intN to read it as signed")
            }
            other => bail!("expected intN, got {}", other.kind()),
        }
    }

    /// A signed field as `i32` — this is how a tick is read.
    pub fn as_i32(&self) -> Result<i32> {
        let v = self.as_i128()?;
        i32::try_from(v).map_err(|_| anyhow!("signed value {v} does not fit in i32"))
    }

    pub fn as_bool(&self) -> Result<bool> {
        match self {
            Value::Bool(b) => Ok(*b),
            other => bail!("expected bool, got {}", other.kind()),
        }
    }

    pub fn as_address(&self) -> Result<Address> {
        match self {
            Value::Address(a) => Ok(*a),
            other => bail!("expected address, got {}", other.kind()),
        }
    }

    /// The lowercase `0x…` form of an address — what the rest of the crate passes around.
    pub fn as_address_string(&self) -> Result<String> {
        Ok(self.as_address()?.to_string())
    }

    pub fn as_str(&self) -> Result<&str> {
        match self {
            Value::String(s) => Ok(s),
            other => bail!("expected string, got {}", other.kind()),
        }
    }

    pub fn as_bytes(&self) -> Result<&[u8]> {
        match self {
            Value::Bytes(b) | Value::FixedBytes(b) => Ok(b),
            other => bail!("expected bytes, got {}", other.kind()),
        }
    }

    /// The 32 bytes of a `bytes32` — a Uniswap v4 pool id, for instance.
    pub fn as_bytes32(&self) -> Result<[u8; 32]> {
        let b = self.as_bytes()?;
        b.try_into()
            .map_err(|_| anyhow!("expected 32 bytes, got {}", b.len()))
    }

    pub fn as_tuple(&self) -> Result<&[Value]> {
        match self {
            Value::Tuple(v) => Ok(v),
            other => bail!("expected tuple, got {}", other.kind()),
        }
    }

    pub fn as_array(&self) -> Result<&[Value]> {
        match self {
            Value::Array(v) => Ok(v),
            other => bail!("expected array, got {}", other.kind()),
        }
    }

    fn is_dynamic(&self) -> bool {
        match self {
            Value::String(_) | Value::Bytes(_) | Value::Array(_) => true,
            Value::Tuple(v) => v.iter().any(Value::is_dynamic),
            _ => false,
        }
    }

    fn head_words(&self) -> usize {
        if self.is_dynamic() {
            return 1;
        }
        match self {
            Value::Tuple(v) => v.iter().map(Value::head_words).sum(),
            _ => 1,
        }
    }
}

/// Positional access to a decoded output list, with the index named in the error.
///
/// Decoding returns `Vec<Value>`; `out.at(5)?` beats `out[5]` because a contract that returns a
/// shorter tuple than expected then says so instead of panicking.
pub trait Fields {
    fn at(&self, index: usize) -> Result<&Value>;
}

impl Fields for [Value] {
    fn at(&self, index: usize) -> Result<&Value> {
        self.get(index)
            .ok_or_else(|| anyhow!("output index {index} missing; only {} fields", self.len()))
    }
}

// ===========================================================================
// Encoding
// ===========================================================================

/// Encode values as an ABI tuple body (no selector).
#[must_use]
pub fn encode(values: &[Value]) -> Vec<u8> {
    let head_size: usize = values.iter().map(|v| v.head_words() * WORD).sum();
    let mut head = Vec::with_capacity(head_size);
    let mut tail = Vec::new();
    for v in values {
        if v.is_dynamic() {
            head.extend_from_slice(&U256::from_u64((head_size + tail.len()) as u64).to_be_bytes());
            tail.extend_from_slice(&encode_value(v));
        } else {
            head.extend_from_slice(&encode_value(v));
        }
    }
    head.extend_from_slice(&tail);
    head
}

fn encode_value(v: &Value) -> Vec<u8> {
    match v {
        Value::Address(a) => {
            let mut word = [0u8; 32];
            word[12..].copy_from_slice(&a.0);
            word.to_vec()
        }
        Value::Bool(b) => {
            let mut word = [0u8; 32];
            word[31] = u8::from(*b);
            word.to_vec()
        }
        Value::Uint(v) | Value::Int(v) => v.to_be_bytes().to_vec(),
        Value::FixedBytes(b) => {
            let mut word = [0u8; 32];
            word[..b.len()].copy_from_slice(b);
            word.to_vec()
        }
        Value::Bytes(b) => {
            let mut out = U256::from_u64(b.len() as u64).to_be_bytes().to_vec();
            out.extend_from_slice(b);
            out.resize(out.len().div_ceil(WORD) * WORD, 0);
            out
        }
        Value::String(s) => encode_value(&Value::Bytes(s.as_bytes().to_vec())),
        Value::Tuple(items) => encode(items),
        Value::Array(items) => {
            let mut out = U256::from_u64(items.len() as u64).to_be_bytes().to_vec();
            out.extend_from_slice(&encode(items));
            out
        }
    }
}

/// The 4-byte selector of a function signature — `keccak256(sig)[..4]`.
///
/// The signature is canonicalised first, so `"balanceOf(address owner)"` and `"getPool(address,
/// address, uint24)"` hash the same as their tight forms.
pub fn selector(signature: &str) -> Result<[u8; 4]> {
    let canonical = canonical_signature(signature)?.0;
    let hash = keccak256(canonical.as_bytes());
    Ok([hash[0], hash[1], hash[2], hash[3]])
}

/// Selector plus encoded arguments — the `data` field of an `eth_call`.
///
/// Arguments are checked against the signature: arity, kind, and integer width. Passing a
/// [`Value::Uint`] where the signature says `int24` is rejected rather than silently encoded,
/// which is the same class of mistake as reading a tick unsigned.
pub fn encode_call(signature: &str, args: &[Value]) -> Result<Vec<u8>> {
    let (canonical, types) = canonical_signature(signature)?;
    if args.len() != types.len() {
        bail!(
            "{canonical} takes {} argument(s), got {}",
            types.len(),
            args.len()
        );
    }
    for (i, (arg, ty)) in args.iter().zip(&types).enumerate() {
        check_value(arg, ty).with_context(|| format!("{canonical} argument {i}"))?;
    }
    let hash = keccak256(canonical.as_bytes());
    let mut out = hash[..4].to_vec();
    out.extend_from_slice(&encode(args));
    Ok(out)
}

/// `name(t1,t2)` with every type canonicalised, plus the parsed argument types.
fn canonical_signature(signature: &str) -> Result<(String, Vec<Type>)> {
    let sig = signature.trim();
    let open = sig
        .find('(')
        .ok_or_else(|| anyhow!("signature {signature:?} has no argument list"))?;
    let close = sig
        .rfind(')')
        .ok_or_else(|| anyhow!("signature {signature:?} has no closing parenthesis"))?;
    if close < open {
        bail!("signature {signature:?} has mismatched parentheses");
    }
    let name = sig[..open].trim();
    if name.is_empty() {
        bail!("signature {signature:?} has no function name");
    }
    let types = Type::parse_list(&sig[open + 1..close])
        .with_context(|| format!("argument types of {signature:?}"))?;
    let parts: Vec<String> = types.iter().map(Type::canonical).collect();
    Ok((format!("{name}({})", parts.join(",")), types))
}

fn check_value(value: &Value, ty: &Type) -> Result<()> {
    match (value, ty) {
        (Value::Address(_), Type::Address)
        | (Value::Bool(_), Type::Bool)
        | (Value::String(_), Type::String)
        | (Value::Bytes(_), Type::Bytes) => Ok(()),
        (Value::Uint(v), Type::Uint(bits)) => {
            if *bits < 256 && v.bits() > u32::from(*bits) {
                bail!("value {v} does not fit in uint{bits}");
            }
            Ok(())
        }
        (Value::Int(v), Type::Int(bits)) => {
            if *bits < 256 && sign_extend(*v, u32::from(*bits)) != *v {
                bail!("value {} does not fit in int{bits}", i128_from_word(*v)?);
            }
            Ok(())
        }
        (Value::Uint(_), Type::Int(bits)) => {
            bail!("argument is int{bits}: build it with Value::int so the sign is encoded")
        }
        (Value::Int(_), Type::Uint(bits)) => bail!("argument is uint{bits}, got a signed value"),
        (Value::FixedBytes(b), Type::FixedBytes(n)) => {
            if b.len() != usize::from(*n) {
                bail!("bytes{n} needs {n} bytes, got {}", b.len());
            }
            Ok(())
        }
        (Value::Tuple(items), Type::Tuple(types)) => {
            if items.len() != types.len() {
                bail!("tuple needs {} fields, got {}", types.len(), items.len());
            }
            for (v, t) in items.iter().zip(types) {
                check_value(v, t)?;
            }
            Ok(())
        }
        (Value::Array(items), Type::Array(inner)) => {
            items.iter().try_for_each(|v| check_value(v, inner))
        }
        (Value::Array(items), Type::FixedArray(inner, n)) => {
            if items.len() != *n {
                bail!(
                    "{}[{n}] needs {n} items, got {}",
                    inner.canonical(),
                    items.len()
                );
            }
            items.iter().try_for_each(|v| check_value(v, inner))
        }
        (v, t) => bail!("expected {}, got {}", t.canonical(), v.kind()),
    }
}

/// `abi.encodePacked` — each value at its own width with no padding and no length prefixes.
///
/// Needs the types because packing is width-sensitive: an `int24` packs to 3 bytes, not 32.
/// The Uniswap v4 position id is
/// `keccak(encode_packed("address,int24,int24,bytes32", &[pm, lower, upper, token_id]))`.
pub fn encode_packed(types: &str, values: &[Value]) -> Result<Vec<u8>> {
    let types = Type::parse_list(types)?;
    if types.len() != values.len() {
        bail!(
            "encode_packed got {} types and {} values",
            types.len(),
            values.len()
        );
    }
    let mut out = Vec::new();
    for (v, t) in values.iter().zip(&types) {
        check_value(v, t)?;
        pack_value(v, t, &mut out)?;
    }
    Ok(out)
}

fn pack_value(value: &Value, ty: &Type, out: &mut Vec<u8>) -> Result<()> {
    match (value, ty) {
        (Value::Address(a), _) => out.extend_from_slice(&a.0),
        (Value::Bool(b), _) => out.push(u8::from(*b)),
        (Value::Uint(v), Type::Uint(bits)) | (Value::Int(v), Type::Int(bits)) => {
            let word = v.to_be_bytes();
            out.extend_from_slice(&word[32 - usize::from(*bits) / 8..]);
        }
        (Value::FixedBytes(b), _) => out.extend_from_slice(b),
        (Value::Bytes(b), _) => out.extend_from_slice(b),
        (Value::String(s), _) => out.extend_from_slice(s.as_bytes()),
        (v, t) => bail!(
            "encode_packed does not support {} as {}",
            v.kind(),
            t.canonical()
        ),
    }
    Ok(())
}

// ===========================================================================
// Decoding
// ===========================================================================

/// Decode a return blob against a comma-separated type list.
///
/// The list is written exactly like the Solidity outputs — e.g. `slot0()` on a Uniswap v3 pool is
/// `"uint160,int24,uint16,uint16,uint16,uint8,bool"`. Empty data is an error: an `eth_call` to an
/// address with no code returns `0x`, which is a missing contract, not a zero value.
pub fn decode(types: &str, data: &[u8]) -> Result<Vec<Value>> {
    let types = Type::parse_list(types)?;
    decode_types(&types, data)
}

/// [`decode`] with pre-parsed types, for a hot path that reuses them.
pub fn decode_types(types: &[Type], data: &[u8]) -> Result<Vec<Value>> {
    if types.is_empty() {
        return Ok(Vec::new());
    }
    if data.is_empty() {
        bail!(
            "empty return data — the call returned 0x, which usually means no contract at that \
             address (or a reverted call whose error was swallowed)"
        );
    }
    decode_body(types, data, 0).context("decoding return data")
}

/// Decode a head starting at `base`; dynamic offsets are relative to `base`.
fn decode_body(types: &[Type], data: &[u8], base: usize) -> Result<Vec<Value>> {
    let mut out = Vec::with_capacity(types.len());
    let mut head = base;
    for (i, ty) in types.iter().enumerate() {
        if ty.is_dynamic() {
            let off = read_offset(data, head)
                .with_context(|| format!("offset of field {i} ({})", ty.canonical()))?;
            let at = base
                .checked_add(off)
                .ok_or_else(|| anyhow!("field {i} offset {off} overflows"))?;
            out.push(
                decode_value(ty, data, at)
                    .with_context(|| format!("field {i} ({})", ty.canonical()))?,
            );
            head += WORD;
        } else {
            out.push(
                decode_value(ty, data, head)
                    .with_context(|| format!("field {i} ({})", ty.canonical()))?,
            );
            head += WORD * ty.head_words();
        }
    }
    Ok(out)
}

fn word_at(data: &[u8], at: usize) -> Result<U256> {
    let end = at
        .checked_add(WORD)
        .ok_or_else(|| anyhow!("offset {at} overflows"))?;
    let slice = data.get(at..end).ok_or_else(|| {
        anyhow!(
            "return data too short: need bytes {at}..{end}, have {}",
            data.len()
        )
    })?;
    Ok(U256::from_be_bytes(slice.try_into().expect("32 bytes")))
}

fn read_offset(data: &[u8], at: usize) -> Result<usize> {
    let word = word_at(data, at)?;
    let off = word
        .try_to_u64()
        .with_context(|| format!("implausible offset {word}"))?;
    usize::try_from(off).map_err(|_| anyhow!("offset {off} does not fit this platform"))
}

fn decode_value(ty: &Type, data: &[u8], at: usize) -> Result<Value> {
    match ty {
        Type::Address => {
            let word = word_at(data, at)?;
            let bytes = word.to_be_bytes();
            if bytes[..12] != [0u8; 12] {
                bail!("address word has dirty high bytes: {}", hex_encode(&bytes));
            }
            Ok(Value::Address(Address(
                bytes[12..].try_into().expect("20 bytes"),
            )))
        }
        Type::Bool => {
            let word = word_at(data, at)?;
            if word == U256::ZERO {
                Ok(Value::Bool(false))
            } else if word == U256::ONE {
                Ok(Value::Bool(true))
            } else {
                bail!("bool word is neither 0 nor 1: {word:#x}")
            }
        }
        Type::Uint(bits) => {
            let word = word_at(data, at)?;
            if *bits < 256 && word.bits() > u32::from(*bits) {
                bail!(
                    "uint{bits} word has bits set above its width ({word:#x}) — if this field is \
                     signed, decode it as int{bits}"
                );
            }
            Ok(Value::Uint(word))
        }
        Type::Int(bits) => {
            let word = word_at(data, at)?;
            // A contract sign-extends to the full word; anything else is a malformed response.
            if *bits < 256 && sign_extend(word, u32::from(*bits)) != word {
                bail!("int{bits} word is not sign-extended: {word:#x}");
            }
            Ok(Value::Int(word))
        }
        Type::FixedBytes(n) => {
            let word = word_at(data, at)?;
            let bytes = word.to_be_bytes();
            let n = usize::from(*n);
            if bytes[n..] != [0u8; 32][n..] {
                bail!(
                    "bytes{n} word has dirty trailing bytes: {}",
                    hex_encode(&bytes)
                );
            }
            Ok(Value::FixedBytes(bytes[..n].to_vec()))
        }
        Type::Bytes | Type::String => {
            let len = read_offset(data, at).context("length prefix")?;
            let start = at + WORD;
            let end = start
                .checked_add(len)
                .ok_or_else(|| anyhow!("length {len} overflows"))?;
            let bytes = data.get(start..end).ok_or_else(|| {
                anyhow!(
                    "return data too short for {len}-byte value at {start}, have {}",
                    data.len()
                )
            })?;
            if matches!(ty, Type::Bytes) {
                Ok(Value::Bytes(bytes.to_vec()))
            } else {
                Ok(Value::String(
                    String::from_utf8(bytes.to_vec()).context("string is not valid UTF-8")?,
                ))
            }
        }
        Type::Tuple(inner) => Ok(Value::Tuple(decode_body(inner, data, at)?)),
        Type::FixedArray(inner, n) => {
            let types = vec![(**inner).clone(); *n];
            Ok(Value::Array(decode_body(&types, data, at)?))
        }
        Type::Array(inner) => {
            let len = read_offset(data, at).context("array length")?;
            // A bogus length must not make us allocate: every element, dynamic or not, takes at
            // least one word of head, so the count cannot exceed the words that follow.
            let available = data.len().saturating_sub(at + WORD) / WORD;
            if len > available {
                bail!("array claims {len} elements but only {available} words of data follow");
            }
            let types = vec![(**inner).clone(); len];
            Ok(Value::Array(decode_body(&types, data, at + WORD)?))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every hex fixture below came out of the Python oracle's own stack — `eth_abi.encode`,
    /// `eth_abi.packed.encode_packed` and `eth_utils.keccak`, the exact code `portfolio.py`
    /// calls — so agreement here is agreement with the thing being ported.
    fn h(s: &str) -> Vec<u8> {
        hex_decode(s).unwrap()
    }

    // ---- U256 ------------------------------------------------------------

    #[test]
    fn u256_compares_by_the_most_significant_limb_first() {
        let two_64 = U256::from_hex("0x10000000000000000").unwrap();
        assert!(two_64 > U256::from_u64(u64::MAX), "2^64 > 2^64-1");
        assert!(U256::MAX > two_64);
        assert!(U256::ZERO < U256::ONE);
    }

    #[test]
    fn u256_round_trips_decimal_and_hex() {
        let cases = [
            "0",
            "1",
            "18446744073709551616",
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            "1461446703485210103287273052203988822378723970341",
        ];
        for c in cases {
            let v = U256::from_dec_str(c).unwrap();
            assert_eq!(v.to_string(), c, "decimal round trip");
            assert_eq!(
                U256::from_hex(&format!("{v:x}")).unwrap(),
                v,
                "hex round trip"
            );
            assert_eq!(U256::from_be_bytes(v.to_be_bytes()), v, "byte round trip");
        }
    }

    #[test]
    fn u256_rejects_decimal_overflow() {
        let past_max =
            "115792089237316195423570985008687907853269984665640564039457584007913129639936";
        assert!(U256::from_dec_str(past_max).is_err());
        assert!(U256::from_hex(&"f".repeat(65)).is_err());
    }

    #[test]
    fn u256_wrapping_sub_matches_the_oracles_masked_subtraction() {
        // portfolio.py computes fee-growth deltas as `(a - b) & U256`, which underflows on
        // purpose; checked_sub is there for the places where underflow would be a bug.
        assert_eq!(U256::ZERO.wrapping_sub(U256::ONE), U256::MAX);
        assert_eq!(U256::MAX.wrapping_add(U256::ONE), U256::ZERO);
        assert_eq!(U256::ZERO.checked_sub(U256::ONE), None);
        assert_eq!(U256::MAX.checked_add(U256::ONE), None);
        assert_eq!(U256::MAX.checked_mul(U256::from_u64(2)), None);
    }

    #[test]
    fn u256_mul_shr_keeps_the_full_512_bit_product() {
        // liquidity * feeGrowthDelta >> 128 — the intermediate exceeds 256 bits even when the
        // result does not, so a plain wrapping_mul would silently lose the top half.
        let liquidity = U256::from_u128(u128::MAX);
        let delta = U256::from_u128(1 << 100);
        let expected = U256::from_u128((1u128 << 100) - 1);
        assert_eq!(liquidity.mul_shr(delta, 128).unwrap(), expected);

        // With a product past 2^256 the naive `mul then shift` silently returns zero, which is
        // exactly the failure mul_shr exists to avoid.
        let (a, b) = (U256::ONE.shl(200), U256::ONE.shl(100));
        assert_eq!(a.mul_shr(b, 128).unwrap(), U256::ONE.shl(172));
        assert_eq!(
            a.wrapping_mul(b).shr(128),
            U256::ZERO,
            "the naive version loses it"
        );
        assert_eq!(
            U256::MAX.mul_shr(U256::MAX, 0),
            None,
            "overflow is reported"
        );
    }

    #[test]
    fn u256_shifts_move_across_limb_boundaries() {
        assert_eq!(U256::ONE.shl(64).to_string(), "18446744073709551616");
        assert_eq!(U256::ONE.shl(255).shr(255), U256::ONE);
        assert_eq!(U256::ONE.shl(256), U256::ZERO);
        assert_eq!(U256::MAX.shr(255), U256::ONE);
        assert_eq!(U256::MAX.shr(256), U256::ZERO);
        assert_eq!(U256::ONE.shl(200).bits(), 201);
    }

    #[test]
    fn u256_as_f64_reaches_the_lp_math_scale() {
        let sqrt_price =
            U256::from_dec_str("1461446703485210103287273052203988822378723970341").unwrap();
        let f = sqrt_price.as_f64();
        assert!((f / 1.4614467034852101e48 - 1.0).abs() < 1e-12, "{f}");
        assert!(f > u128::MAX as f64, "beyond u128, as lp_math warns");
    }

    // ---- keccak ----------------------------------------------------------

    #[test]
    fn keccak256_matches_eth_utils() {
        // Inputs either side of the 136-byte rate, so a padding or absorb bug shows up.
        let long: &[u8] = b"the quick brown fox jumps over the lazy dog, repeatedly, until the \
                            input exceeds one keccak rate block of 136 bytes so the sponge \
                            absorbs more than once";
        let cases: [(&[u8], &str); 6] = [
            (
                b"",
                "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
            ),
            (
                b"abc",
                "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
            ),
            (
                long,
                "0x51e50a5dcfe1674cc9e28a8951ed32524af548b979f4105be48679f04465f984",
            ),
            (
                &[b'a'; 135],
                "0x34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446",
            ),
            (
                &[b'a'; 136],
                "0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e",
            ),
            (
                &[b'a'; 137],
                "0xd869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(hex_encode(&keccak256(input)), want, "{} bytes", input.len());
        }
    }

    #[test]
    fn selectors_match_every_function_the_oracle_calls() {
        let cases = [
            ("positions(uint256)", "0x99fbab88"),
            ("balanceOf(address)", "0x70a08231"),
            ("tokenOfOwnerByIndex(address,uint256)", "0x2f745c59"),
            ("slot0()", "0x3850c7bd"),
            ("decimals()", "0x313ce567"),
            ("symbol()", "0x95d89b41"),
            ("name()", "0x06fdde03"),
            ("factory()", "0xc45a0155"),
            ("getPool(address,address,uint24)", "0x1698ee82"),
            ("ticks(int24)", "0xf30dba93"),
            ("feeGrowthGlobal0X128()", "0xf3058399"),
            ("getSlot0(bytes32)", "0xc815641c"),
            ("getFeeGrowthInside(bytes32,int24,int24)", "0x53e9c1fb"),
            ("getPositionInfo(bytes32,bytes32)", "0x97fd7b42"),
            ("getPoolAndPositionInfo(uint256)", "0x7ba03aad"),
            ("getPositionLiquidity(uint256)", "0x1efeed33"),
            ("convertToAssets(uint256)", "0x07a2d13a"),
            ("asset()", "0x38d52e0f"),
            ("sickles(address)", "0x967e4da8"),
            ("getUserAccountData(address)", "0xbf92857c"),
            ("getAllReservesTokens()", "0xb316ff89"),
            ("getAssetInfo(uint8)", "0xc8c7fe6b"),
            ("userCollateral(address,address)", "0x2b92a07d"),
        ];
        for (sig, want) in cases {
            assert_eq!(hex_encode(&selector(sig).unwrap()), want, "{sig}");
        }
    }

    #[test]
    fn a_signature_is_canonicalised_before_hashing() {
        // Named parameters, stray spaces and the `uint` alias must not move the selector.
        assert_eq!(
            selector("balanceOf(address owner)").unwrap(),
            selector("balanceOf(address)").unwrap()
        );
        assert_eq!(
            selector("getPool(address, address, uint24)").unwrap(),
            selector("getPool(address,address,uint24)").unwrap()
        );
        assert_eq!(
            selector("convertToAssets(uint)").unwrap(),
            selector("convertToAssets(uint256)").unwrap()
        );
        assert!(selector("noParens").is_err());
    }

    #[test]
    fn address_checksums_per_eip55() {
        let a = Address::from_hex("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2").unwrap();
        assert_eq!(
            a.to_checksum(),
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        );
        assert_eq!(a.to_string(), "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
        assert_eq!(Address::from_hex(&a.to_checksum()).unwrap(), a);
        assert!(Address::ZERO.is_zero());
        assert!(Address::from_hex("0xdead").is_err(), "wrong length");
    }

    // ---- decoding: the sign-extension trap -------------------------------

    #[test]
    fn a_negative_int24_tick_decodes_to_the_right_negative_number() {
        // eth_abi.encode(["int24"], [v]) for each v.
        let cases = [
            (
                -1i32,
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            ),
            (
                0,
                "0000000000000000000000000000000000000000000000000000000000000000",
            ),
            (
                1,
                "0000000000000000000000000000000000000000000000000000000000000001",
            ),
            (
                -8_388_608,
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff800000",
            ),
            (
                8_388_607,
                "00000000000000000000000000000000000000000000000000000000007fffff",
            ),
            (
                -887_272,
                "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff27618",
            ),
            (
                887_272,
                "00000000000000000000000000000000000000000000000000000000000d89e8",
            ),
            (
                -256,
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00",
            ),
            (
                255,
                "00000000000000000000000000000000000000000000000000000000000000ff",
            ),
        ];
        for (want, hex) in cases {
            let out = decode("int24", &h(hex)).unwrap();
            assert_eq!(out.at(0).unwrap().as_i32().unwrap(), want, "int24 {want}");
        }
    }

    #[test]
    fn reading_a_negative_tick_unsigned_is_refused_rather_than_wrong() {
        let word = h("fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff27618");
        let signed = decode("int24", &word).unwrap();
        assert_eq!(signed.at(0).unwrap().as_i32().unwrap(), -887_272);

        // The raw word read as unsigned is the astronomically wrong number the port must never
        // produce. as_u128 refuses a signed field outright...
        assert!(signed.at(0).unwrap().as_u128().is_err());
        assert!(
            signed.at(0).unwrap().as_u256().unwrap() > U256::ONE.shl(200),
            "the raw word really is enormous — which is why as_u128 refuses it"
        );

        // ...and declaring the field uint24 fails loudly instead of yielding ~1.15e77.
        let err = decode("uint24", &word).unwrap_err();
        assert!(format!("{err:#}").contains("decode it as int24"), "{err:#}");
    }

    #[test]
    fn as_i32_refuses_a_field_that_was_decoded_unsigned() {
        let out = decode(
            "uint24",
            &h("00000000000000000000000000000000000000000000000000000000000d89e8"),
        )
        .unwrap();
        let err = out.at(0).unwrap().as_i32().unwrap_err();
        assert!(format!("{err:#}").contains("decode it as intN"), "{err:#}");
    }

    #[test]
    fn wide_signed_types_decode_too() {
        let out = decode(
            "int56",
            &h("ffffffffffffffffffffffffffffffffffffffffffffffffff80000000000000"),
        )
        .unwrap();
        assert_eq!(
            out.at(0).unwrap().as_i128().unwrap(),
            -36_028_797_018_963_968
        );

        let out = decode(
            "int128",
            &h("ffffffffffffffffffffffffffffffff80000000000000000000000000000000"),
        )
        .unwrap();
        assert_eq!(out.at(0).unwrap().as_i128().unwrap(), i128::MIN);

        let out = decode(
            "int256",
            &h("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        )
        .unwrap();
        assert_eq!(out.at(0).unwrap().as_i128().unwrap(), -1);

        // int256's extremes do not fit i128, and say so rather than truncating.
        let out = decode(
            "int256",
            &h("8000000000000000000000000000000000000000000000000000000000000000"),
        )
        .unwrap();
        assert!(out.at(0).unwrap().as_i128().is_err());
    }

    #[test]
    fn a_word_that_is_not_sign_extended_is_rejected() {
        // The low 24 bits say -887272 but the high bits are clear: not something a contract
        // emits, and accepting it would mean guessing which half to believe.
        assert!(
            decode(
                "int24",
                &h("00000000000000000000000000000000000000000000000000000000fff27618")
            )
            .is_err()
        );
    }

    #[test]
    fn sign_extension_is_idempotent_and_leaves_positives_alone() {
        let positive = U256::from_u64(0x0d_89e8);
        assert_eq!(sign_extend(positive, 24), positive);

        let negative = sign_extend(U256::from_u64(0xf2_7618), 24);
        assert_eq!(sign_extend(negative, 24), negative, "idempotent");
        assert_eq!(i128_from_word(negative).unwrap(), -887_272);
        assert_eq!(word_from_i128(-887_272), negative, "round trip");
        assert_eq!(word_from_i128(0), U256::ZERO);
        assert_eq!(word_from_i128(-1), U256::MAX);
    }

    // ---- decoding: values above 2^64 -------------------------------------

    #[test]
    fn uint256_values_above_2p64_survive() {
        let cases = [
            (
                "0000000000000000000000000000000000000000000000010000000000000000",
                "18446744073709551616",
            ),
            (
                "000000000000000000000000000000000000000000000000ffffffffffffffff",
                "18446744073709551615",
            ),
            (
                "8000000000000000000000000000000000000000000000000000000000003039",
                "57896044618658097711785492504343953926634992332820282019728792003956564832313",
            ),
            (
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            ),
        ];
        for (hex, want) in cases {
            let out = decode("uint256", &h(hex)).unwrap();
            assert_eq!(out.at(0).unwrap().as_u256().unwrap().to_string(), want);
        }

        // Narrowing one of them is refused rather than truncated.
        let out = decode(
            "uint256",
            &h("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        )
        .unwrap();
        assert!(out.at(0).unwrap().as_u128().is_err());
        assert!(out.at(0).unwrap().as_u64().is_err());
    }

    #[test]
    fn a_uint160_sqrt_price_beyond_u128_decodes_exactly() {
        // slot0() near the top of the tick range: sqrtPriceX96 ~1.46e48, well past u128::MAX.
        let out = decode(
            "uint160,int24,uint16,uint16,uint16,uint8,bool",
            &h(
                "000000000000000000000000fffd8963efd1fc6a506488495d951d5263988d25\
                fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffee250\
                0000000000000000000000000000000000000000000000000000000000000001\
                0000000000000000000000000000000000000000000000000000000000000002\
                0000000000000000000000000000000000000000000000000000000000000003\
                0000000000000000000000000000000000000000000000000000000000000000\
                0000000000000000000000000000000000000000000000000000000000000001",
            ),
        )
        .unwrap();
        assert_eq!(
            out.at(0).unwrap().as_u256().unwrap().to_string(),
            "1461446703485210103287273052203988822378723970341"
        );
        assert_eq!(
            out.at(1).unwrap().as_i32().unwrap(),
            -73_136,
            "current tick"
        );
        assert_eq!(out.at(5).unwrap().as_u8().unwrap(), 0);
        assert!(out.at(6).unwrap().as_bool().unwrap());
        assert!(
            out.at(0).unwrap().as_u128().is_err(),
            "uint160 exceeds u128"
        );
    }

    // ---- decoding: real return blobs -------------------------------------

    const POSITIONS_OUTPUTS: &str =
        "uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128";

    #[test]
    fn a_real_positions_return_decodes_field_for_field() {
        let data = h(
            "000000000000000000000000000000000000000000000000ab54a98ceb1f0ad2\
                      000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2\
                      000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\
                      0000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c599\
                      0000000000000000000000000000000000000000000000000000000000000bb8\
                      fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2764c\
                      ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c\
                      00000000000000000000000000000000000000000001056e0f36a6443de2df79\
                      ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\
                      0000000000000000000000000000000100000000000000000000000000000000\
                      0000000000000000000000000000000000000000000000055aa54d38e5267eea\
                      0000000000000000000000000000000000000000000000000000000000000000",
        );
        let p = decode(POSITIONS_OUTPUTS, &data).unwrap();
        assert_eq!(p.len(), 12);
        assert_eq!(
            p.at(0).unwrap().as_u128().unwrap(),
            12_345_678_901_234_567_890,
            "nonce"
        );
        assert_eq!(
            p.at(1).unwrap().as_address_string().unwrap(),
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "operator"
        );
        assert_eq!(
            p.at(3).unwrap().as_address().unwrap().to_checksum(),
            "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
            "token1"
        );
        assert_eq!(p.at(4).unwrap().as_u64().unwrap(), 3000, "fee tier");
        assert_eq!(p.at(5).unwrap().as_i32().unwrap(), -887_220, "tickLower");
        assert_eq!(p.at(6).unwrap().as_i32().unwrap(), -100, "tickUpper");
        assert_eq!(
            p.at(7).unwrap().as_u128().unwrap(),
            1_234_567_890_123_456_789_012_345,
            "liquidity"
        );
        assert_eq!(
            p.at(8).unwrap().as_u256().unwrap(),
            U256::MAX,
            "feeGrowthInside0"
        );
        assert_eq!(
            p.at(9).unwrap().as_u256().unwrap().to_string(),
            "340282366920938463463374607431768211456",
            "feeGrowthInside1 (2^128, past u128::MAX)"
        );
        assert_eq!(
            p.at(10).unwrap().as_u128().unwrap(),
            98_765_432_109_876_543_210,
            "tokensOwed0"
        );
        assert!(
            p.at(11).unwrap().as_u256().unwrap().is_zero(),
            "tokensOwed1"
        );
        assert!(
            p.at(12).is_err(),
            "a missing field errors instead of panicking"
        );
    }

    #[test]
    fn positions_at_the_extreme_ticks_decodes() {
        let data = h(
            "0000000000000000000000000000000000000000000000000000000000000000\
                      0000000000000000000000001111111111111111111111111111111111111111\
                      0000000000000000000000002222222222222222222222222222222222222222\
                      0000000000000000000000003333333333333333333333333333333333333333\
                      00000000000000000000000000000000000000000000000000000000000001f4\
                      fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff27618\
                      00000000000000000000000000000000000000000000000000000000000d89e8\
                      0000000000000000000000000000000000000000000000000000000000000000\
                      0000000000000000000000000000000000000000000000000000000000000000\
                      0000000000000000000000000000000000000000000000000000000000000000\
                      0000000000000000000000000000000000000000000000000000000000000000\
                      0000000000000000000000000000000000000000000000000000000000000000",
        );
        let p = decode(POSITIONS_OUTPUTS, &data).unwrap();
        assert_eq!(
            p.at(5).unwrap().as_i32().unwrap(),
            -crate::lp_math::MAX_TICK
        );
        assert_eq!(p.at(6).unwrap().as_i32().unwrap(), crate::lp_math::MAX_TICK);
    }

    #[test]
    fn a_v4_pool_key_tuple_and_position_info_decode() {
        // getPoolAndPositionInfo(uint256) -> ((address,address,uint24,int24,address), uint256).
        // The tuple is entirely static, so it sits inline with no offset word.
        let data = h(
            "0000000000000000000000000000000000000000000000000000000000000000\
                      000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\
                      00000000000000000000000000000000000000000000000000000000000001f4\
                      000000000000000000000000000000000000000000000000000000000000000a\
                      0000000000000000000000000000000000000000000000000000000000000000\
                      000000000021c67e77068de97969ba93d4aab21826d33ca12b000d1c000c1800",
        );
        let out = decode("(address,address,uint24,int24,address),uint256", &data).unwrap();
        let key = out.at(0).unwrap().as_tuple().unwrap();
        assert!(
            key.at(0).unwrap().as_address().unwrap().is_zero(),
            "native currency0"
        );
        assert_eq!(
            key.at(1).unwrap().as_address_string().unwrap(),
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
        );
        assert_eq!(key.at(2).unwrap().as_u64().unwrap(), 500, "fee");
        assert_eq!(key.at(3).unwrap().as_i32().unwrap(), 10, "tickSpacing");
        assert!(
            key.at(4).unwrap().as_address().unwrap().is_zero(),
            "no hook"
        );

        // The packed PositionInfo word carries the ticks; lp_math::s24 unpacks them, and the
        // pool id is the keccak of the re-encoded key.
        let info = out.at(1).unwrap().as_u256().unwrap();
        let mask = U256::from_u64(0xff_ffff);
        let tick_lower = crate::lp_math::s24((info.shr(8) & mask).low_u64() as u32);
        let tick_upper = crate::lp_math::s24((info.shr(32) & mask).low_u64() as u32);
        assert_eq!((tick_lower, tick_upper), (3096, 3356));

        let pool_id = keccak256(&encode(key));
        assert_eq!(
            hex_encode(&pool_id),
            "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27",
            "matches keccak(abi_encode(poolKey)) from the oracle"
        );
    }

    #[test]
    fn a_dynamic_array_of_dynamic_tuples_decodes() {
        // Avalon/Aave getAllReservesTokens() -> (string symbol, address token)[]
        let data = h(
            "0000000000000000000000000000000000000000000000000000000000000020\
                      0000000000000000000000000000000000000000000000000000000000000002\
                      0000000000000000000000000000000000000000000000000000000000000040\
                      00000000000000000000000000000000000000000000000000000000000000c0\
                      0000000000000000000000000000000000000000000000000000000000000040\
                      000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\
                      0000000000000000000000000000000000000000000000000000000000000004\
                      5553444300000000000000000000000000000000000000000000000000000000\
                      0000000000000000000000000000000000000000000000000000000000000040\
                      0000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c599\
                      000000000000000000000000000000000000000000000000000000000000000b\
                      536f6c764254432e42424e000000000000000000000000000000000000000000",
        );
        let out = decode("(string,address)[]", &data).unwrap();
        let items = out.at(0).unwrap().as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            items
                .at(0)
                .unwrap()
                .as_tuple()
                .unwrap()
                .at(0)
                .unwrap()
                .as_str()
                .unwrap(),
            "USDC"
        );
        assert_eq!(
            items
                .at(1)
                .unwrap()
                .as_tuple()
                .unwrap()
                .at(0)
                .unwrap()
                .as_str()
                .unwrap(),
            "SolvBTC.BBN"
        );
        assert_eq!(
            items
                .at(1)
                .unwrap()
                .as_tuple()
                .unwrap()
                .at(1)
                .unwrap()
                .as_address_string()
                .unwrap(),
            "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"
        );

        let empty = decode(
            "(string,address)[]",
            &h(
                "0000000000000000000000000000000000000000000000000000000000000020\
                0000000000000000000000000000000000000000000000000000000000000000",
            ),
        )
        .unwrap();
        assert!(empty.at(0).unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn a_static_struct_return_decodes_inline() {
        // Compound Comet getAssetInfo(uint8) -> a static struct.
        let data = h(
            "0000000000000000000000000000000000000000000000000000000000000003\
                      0000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c599\
                      000000000000000000000000f4030086522a5beea4988f8ca5b36dbc97bee88c\
                      0000000000000000000000000000000000000000000000000000000005f5e100\
                      0000000000000000000000000000000000000000000000000b1a2bc2ec500000\
                      0000000000000000000000000000000000000000000000000bcbce7f1b150000\
                      0000000000000000000000000000000000000000000000000d2f13f7789f0000\
                      00000000000000000000000000000000000000000000000000000006fc23ac00",
        );
        let out = decode(
            "(uint8,address,address,uint64,uint64,uint64,uint64,uint128)",
            &data,
        )
        .unwrap();
        let t = out.at(0).unwrap().as_tuple().unwrap();
        assert_eq!(t.at(0).unwrap().as_u8().unwrap(), 3, "offset");
        assert_eq!(
            t.at(2).unwrap().as_address_string().unwrap(),
            "0xf4030086522a5beea4988f8ca5b36dbc97bee88c",
            "priceFeed"
        );
        assert_eq!(t.at(3).unwrap().as_u64().unwrap(), 100_000_000, "scale");
        assert_eq!(
            t.at(7).unwrap().as_u128().unwrap(),
            30_000_000_000,
            "supplyCap"
        );
    }

    #[test]
    fn strings_decode_at_and_across_the_word_boundary() {
        let usdc = decode(
            "string",
            &h(
                "0000000000000000000000000000000000000000000000000000000000000020\
                0000000000000000000000000000000000000000000000000000000000000004\
                5553444300000000000000000000000000000000000000000000000000000000",
            ),
        )
        .unwrap();
        assert_eq!(usdc.at(0).unwrap().as_str().unwrap(), "USDC", "symbol()");

        let long = decode(
            "string",
            &h(
                "0000000000000000000000000000000000000000000000000000000000000020\
                000000000000000000000000000000000000000000000000000000000000003c\
                4761756e746c6574205742544320436f7265205661756c7420546f6b656e2045\
                78747261204c6f6e67204e616d65204f76657220333220427974657300000000",
            ),
        )
        .unwrap();
        assert_eq!(
            long.at(0).unwrap().as_str().unwrap(),
            "Gauntlet WBTC Core Vault Token Extra Long Name Over 32 Bytes",
            "name() spanning two words"
        );

        let empty = decode(
            "string",
            &h(
                "0000000000000000000000000000000000000000000000000000000000000020\
                0000000000000000000000000000000000000000000000000000000000000000",
            ),
        )
        .unwrap();
        assert_eq!(empty.at(0).unwrap().as_str().unwrap(), "");
    }

    #[test]
    fn a_uint256_array_decodes() {
        let out = decode(
            "uint256[]",
            &h(
                "0000000000000000000000000000000000000000000000000000000000000020\
                0000000000000000000000000000000000000000000000000000000000000003\
                0000000000000000000000000000000000000000000000000000000000000001\
                0000000000000000000000000000000000000000000000010000000000000000\
                8000000000000000000000000000000000000000000000000000000000000000",
            ),
        )
        .unwrap();
        let items = out.at(0).unwrap().as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items.at(0).unwrap().as_u64().unwrap(), 1);
        assert_eq!(
            items.at(1).unwrap().as_u256().unwrap().to_string(),
            "18446744073709551616"
        );
        assert_eq!(items.at(2).unwrap().as_u256().unwrap(), U256::ONE.shl(255));
    }

    // ---- decoding: bad input --------------------------------------------

    #[test]
    fn empty_return_data_is_an_error_that_names_the_cause() {
        let err = decode("uint256", &[]).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("empty return data"), "{text}");
        assert!(
            text.contains("no contract"),
            "should hint at the cause: {text}"
        );
        // A function with no outputs is not the same thing: nothing to decode, no error.
        assert!(decode("", &[]).unwrap().is_empty());
    }

    #[test]
    fn truncated_return_data_errors_instead_of_panicking() {
        assert!(
            decode("uint256,uint256", &[0u8; 32]).is_err(),
            "half a tuple"
        );
        assert!(decode("uint256", &[0u8; 31]).is_err(), "partial word");
        // An offset that points past the end of the blob.
        assert!(
            decode(
                "string",
                &h("00000000000000000000000000000000000000000000000000000000000000ff")
            )
            .is_err()
        );
        // A length prefix longer than the data that follows.
        assert!(
            decode(
                "string",
                &h(
                    "0000000000000000000000000000000000000000000000000000000000000020\
                    0000000000000000000000000000000000000000000000000000000000000040\
                    4142430000000000000000000000000000000000000000000000000000000000"
                )
            )
            .is_err()
        );
    }

    #[test]
    fn dirty_padding_is_rejected() {
        // A word whose high bytes are not zero is not a valid address, and quietly masking it
        // would hide whatever produced it.
        assert!(
            decode(
                "address",
                &h("00000000000000000000000100000000000000000000000000000000deadbeef")
            )
            .is_err()
        );
        assert!(
            decode(
                "bool",
                &h("0000000000000000000000000000000000000000000000000000000000000002")
            )
            .is_err()
        );
        assert!(
            decode(
                "bytes32",
                &h("21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27")
            )
            .is_ok()
        );
    }

    #[test]
    fn an_absurd_array_length_does_not_allocate() {
        let bogus = h(
            "0000000000000000000000000000000000000000000000000000000000000020\
                       ffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000",
        );
        assert!(decode("uint256[]", &bogus).is_err());
    }

    // ---- encoding --------------------------------------------------------

    #[test]
    fn calldata_matches_the_oracles_encoding() {
        let cases: [(&str, Vec<Value>, &str); 6] = [
            (
                "positions(uint256)",
                vec![Value::uint(12345u64)],
                "0x99fbab880000000000000000000000000000000000000000000000000000000000003039",
            ),
            (
                "balanceOf(address)",
                vec![Value::address("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2").unwrap()],
                "0x70a08231000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            ),
            (
                "getPool(address,address,uint24)",
                vec![
                    Value::address("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2").unwrap(),
                    Value::address("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48").unwrap(),
                    Value::uint(3000u64),
                ],
                "0x1698ee82\
                 000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2\
                 000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\
                 0000000000000000000000000000000000000000000000000000000000000bb8",
            ),
            (
                "ticks(int24)",
                vec![Value::int(-887_220)],
                "0xf30dba93fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2764c",
            ),
            (
                "getFeeGrowthInside(bytes32,int24,int24)",
                vec![
                    Value::bytes32(
                        h("21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27")
                            .try_into()
                            .unwrap(),
                    ),
                    Value::int(-100),
                    Value::int(200),
                ],
                "0x53e9c1fb\
                 21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27\
                 ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c\
                 00000000000000000000000000000000000000000000000000000000000000c8",
            ),
            ("slot0()", vec![], "0x3850c7bd"),
        ];
        for (sig, args, want) in cases {
            assert_eq!(hex_encode(&encode_call(sig, &args).unwrap()), want, "{sig}");
        }
    }

    #[test]
    fn encode_call_rejects_a_signed_argument_passed_unsigned() {
        // The mirror of the decode-side trap: a tick argument must be built with Value::int,
        // or a negative tick would go out as a positive one.
        let err = encode_call("ticks(int24)", &[Value::uint(100u64)]).unwrap_err();
        assert!(format!("{err:#}").contains("Value::int"), "{err:#}");

        // A value too wide for the declared type is caught before it reaches a node.
        assert!(
            encode_call(
                "getPool(address,address,uint24)",
                &[
                    Value::address("0x0000000000000000000000000000000000000001").unwrap(),
                    Value::address("0x0000000000000000000000000000000000000002").unwrap(),
                    Value::uint(1u64 << 40),
                ]
            )
            .is_err()
        );
        assert!(encode_call("ticks(int24)", &[Value::int(9_000_000)]).is_err());
        assert!(encode_call("positions(uint256)", &[]).is_err(), "arity");
        assert!(
            encode_call("balanceOf(address)", &[Value::uint(1u64)]).is_err(),
            "kind"
        );
    }

    #[test]
    fn encoding_round_trips_through_decoding() {
        let values = vec![
            Value::uint(U256::MAX),
            Value::int(-887_220),
            Value::address("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2").unwrap(),
            Value::String("Gauntlet WBTC Core Vault Token Extra Long Name Over 32 Bytes".into()),
            Value::Bool(true),
            Value::Array(vec![Value::uint(1u64), Value::uint(U256::ONE.shl(200))]),
            Value::Tuple(vec![Value::uint(500u64), Value::int(10)]),
        ];
        let encoded = encode(&values);
        let decoded = decode(
            "uint256,int24,address,string,bool,uint256[],(uint24,int24)",
            &encoded,
        )
        .unwrap();
        assert_eq!(decoded, values);
    }

    #[test]
    fn encoding_a_string_matches_the_oracle_byte_for_byte() {
        assert_eq!(
            hex_encode(&encode(&[Value::String("USDC".into())])),
            "0x0000000000000000000000000000000000000000000000000000000000000020\
               0000000000000000000000000000000000000000000000000000000000000004\
               5553444300000000000000000000000000000000000000000000000000000000"
        );
        assert_eq!(
            hex_encode(&encode(&[Value::Array(vec![
                Value::uint(1u64),
                Value::uint(U256::ONE.shl(64)),
                Value::uint(U256::ONE.shl(255)),
            ])])),
            "0x0000000000000000000000000000000000000000000000000000000000000020\
               0000000000000000000000000000000000000000000000000000000000000003\
               0000000000000000000000000000000000000000000000000000000000000001\
               0000000000000000000000000000000000000000000000010000000000000000\
               8000000000000000000000000000000000000000000000000000000000000000"
        );
    }

    #[test]
    fn the_v4_pool_id_matches_the_oracle() {
        // keccak(abi_encode(["address","address","uint24","int24","address"], [...]))
        let encoded = encode(&[
            Value::address("0x0000000000000000000000000000000000000000").unwrap(),
            Value::address("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48").unwrap(),
            Value::uint(500u64),
            Value::int(10),
            Value::address("0x0000000000000000000000000000000000000000").unwrap(),
        ]);
        assert_eq!(
            hex_encode(&keccak256(&encoded)),
            "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27"
        );
    }

    #[test]
    fn encode_packed_matches_the_oracle() {
        // eth_abi.packed.encode_packed(["address","int24","int24","bytes32"], [...]) — note the
        // int24s take three bytes each, which is why packing needs the types.
        let packed = encode_packed(
            "address,int24,int24,bytes32",
            &[
                Value::address("0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e").unwrap(),
                Value::int(-100),
                Value::int(200),
                Value::bytes32(U256::from_u64(7777).to_be_bytes()),
            ],
        )
        .unwrap();
        assert_eq!(
            hex_encode(&packed),
            "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e\
               ffff9c\
               0000c8\
               0000000000000000000000000000000000000000000000000000000000001e61"
        );
        // ...and the v4 position id is the keccak of exactly that.
        assert_eq!(
            hex_encode(&keccak256(&packed)),
            "0x12dfe937ccf453289f7a3934311a256bb924240ee01884fb22f116741e4e07a3"
        );

        let mixed = encode_packed(
            "uint256,bool,uint8",
            &[
                Value::uint(U256::ONE.shl(200)),
                Value::Bool(true),
                Value::uint(7u64),
            ],
        )
        .unwrap();
        assert_eq!(
            hex_encode(&mixed),
            "0x0000000000000100000000000000000000000000000000000000000000000000\
               01\
               07"
        );
    }

    // ---- type parsing ----------------------------------------------------

    #[test]
    fn types_parse_and_canonicalise() {
        let cases = [
            ("uint", "uint256"),
            ("int", "int256"),
            ("uint24", "uint24"),
            ("(address,uint24)[]", "(address,uint24)[]"),
            ("tuple(string,address)[]", "(string,address)[]"),
            ("uint256[3]", "uint256[3]"),
            ("bytes32", "bytes32"),
            (
                "(uint160,int24,(bool,address))",
                "(uint160,int24,(bool,address))",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(Type::parse(input).unwrap().canonical(), want, "{input}");
        }
        assert!(
            Type::parse("uint7").is_err(),
            "width must be a multiple of 8"
        );
        assert!(Type::parse("uint264").is_err());
        assert!(Type::parse("bytes33").is_err());
        assert!(Type::parse("nonsense").is_err());
        assert!(Type::parse_list("(uint256,address").is_err(), "unbalanced");
        assert_eq!(Type::parse_list("").unwrap(), Vec::new());
        assert_eq!(Type::parse_list("uint256,(int24,bool)[]").unwrap().len(), 2);
    }

    #[test]
    fn dynamic_types_are_recognised() {
        assert!(!Type::parse("(uint160,int24)").unwrap().is_dynamic());
        assert!(Type::parse("(string,address)").unwrap().is_dynamic());
        assert!(Type::parse("uint256[]").unwrap().is_dynamic());
        assert!(!Type::parse("uint256[3]").unwrap().is_dynamic());
        assert!(Type::parse("string[3]").unwrap().is_dynamic());
        assert_eq!(Type::parse("(uint160,int24,bool)").unwrap().head_words(), 3);
        assert_eq!(Type::parse("uint256[3]").unwrap().head_words(), 3);
        assert_eq!(Type::parse("string").unwrap().head_words(), 1);
    }
}
