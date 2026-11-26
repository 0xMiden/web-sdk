//! Bounds the records a list query hands to JavaScript.
//!
//! The store still reads every match, since [`miden_client::store::Store`] has no paged reads;
//! what stays in WASM memory is everything past the limit, which is never turned into JS objects.

use alloc::vec::Vec;

/// The `limit` records of `items` with the greatest `key`, greatest first.
pub(crate) fn newest_first<T, K: Ord>(
    mut items: Vec<T>,
    key: impl Fn(&T) -> K,
    limit: Option<u32>,
) -> Vec<T> {
    items.sort_by_cached_key(|item| core::cmp::Reverse(key(item)));
    truncate(items, limit)
}

fn truncate<T>(mut items: Vec<T>, limit: Option<u32>) -> Vec<T> {
    if let Some(limit) = limit {
        items.truncate(limit as usize);
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_first_orders_by_key_then_cuts_to_the_limit() {
        let items = vec![(2, "b"), (9, "a"), (5, "c"), (9, "z")];
        let all = newest_first(items.clone(), |item| *item, None);
        assert_eq!(all, vec![(9, "z"), (9, "a"), (5, "c"), (2, "b")]);
        assert_eq!(newest_first(items, |item| *item, Some(2)), vec![(9, "z"), (9, "a")]);
    }
}
