//! Edge-autoscroll zone tests for `ui`.
//!
//! Split out of `ui.rs` so that file can stay under the code-size ratchet;
//! `ui.rs` already uses this `#[path]` pattern for its main test module.

use super::edge_autoscroll_zone_rows;

#[test]
fn zone_is_at_least_one_row_for_tiny_panes() {
    // Even a 1-2 row pane should keep a usable hot zone so the edge still triggers.
    assert_eq!(edge_autoscroll_zone_rows(0), 1);
    assert_eq!(edge_autoscroll_zone_rows(1), 1);
    assert_eq!(edge_autoscroll_zone_rows(3), 1);
    assert_eq!(edge_autoscroll_zone_rows(4), 1);
}

#[test]
fn zone_scales_with_height_but_is_capped() {
    assert_eq!(edge_autoscroll_zone_rows(8), 2);
    assert_eq!(edge_autoscroll_zone_rows(12), 3);
    // Capped at 3 so tall panes keep a large neutral middle region.
    assert_eq!(edge_autoscroll_zone_rows(40), 3);
    assert_eq!(edge_autoscroll_zone_rows(200), 3);
}
