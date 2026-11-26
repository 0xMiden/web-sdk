//! Bounds the records a list query hands to JavaScript.
//!
//! The store still reads every match, since [`miden_client::store::Store`] has no paged reads;
//! what stays in WASM memory is everything past the page, which is never turned into JS objects.

use alloc::vec::Vec;

/// The `limit` records of `items` with the greatest `key`, greatest first.
pub(crate) fn newest_first<T, K: Ord>(
    mut items: Vec<T>,
    key: impl Fn(&T) -> K,
    limit: Option<u32>,
) -> Vec<T> {
    items.sort_by_key(|item| core::cmp::Reverse(key(item)));
    truncate(items, limit)
}

/// The `limit` records of `items` whose `key` is above `after`, in ascending `key` order.
pub(crate) fn page_after<T, K: Ord>(
    mut items: Vec<T>,
    key: impl Fn(&T) -> K,
    after: Option<&K>,
    limit: Option<u32>,
) -> Vec<T> {
    items.sort_by_key(&key);
    if let Some(after) = after {
        items.retain(|item| key(item) > *after);
    }
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

    #[test]
    fn page_after_walks_every_item_once() {
        let items: Vec<u32> = (0..10).rev().collect();
        let mut seen = Vec::new();
        let mut after = None;
        loop {
            let page = page_after(items.clone(), |item| *item, after.as_ref(), Some(4));
            let Some(last) = page.last().copied() else { break };
            seen.extend(page);
            after = Some(last);
        }
        assert_eq!(seen, (0..10).collect::<Vec<u32>>());
    }

    #[test]
    fn page_after_an_unknown_cursor_resumes_above_it() {
        let page = page_after(vec![1, 3, 5, 7], |item| *item, Some(&4), Some(1));
        assert_eq!(page, vec![5]);
    }
}
