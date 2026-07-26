import pathlib
import sys
import unittest

TOOLS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))

from x_timeline_state import (  # noqa: E402
    following_timeline_ready,
    selected_top_tab,
    timeline_tree_ready,
    x_tree_ready,
)


class XTimelineStateTests(unittest.TestCase):
    def test_following_selected_on_label_is_proved(self):
        tree = """NODES display=9 pkg=com.twitter.android
FrameLayout
  TextView text="For you" [clickable]
  TextView text="Following" [clickable] [selected]
  TextView text="a timeline item"
"""
        self.assertTrue(x_tree_ready(tree))
        self.assertTrue(timeline_tree_ready(tree))
        self.assertEqual(selected_top_tab(tree), "Following")
        self.assertTrue(following_timeline_ready(tree))

    def test_following_selected_on_parent_is_proved(self):
        tree = """NODES display=4 pkg=com.twitter.android
FrameLayout
  LinearLayout
    TextView text="For you" [clickable]
  LinearLayout [selected]
    TextView desc="Following, Tab" [clickable]
"""
        self.assertEqual(selected_top_tab(tree), "Following")
        self.assertTrue(following_timeline_ready(tree))

    def test_for_you_or_ambiguous_selection_is_not_following(self):
        for_you = """NODES display=3 pkg=com.twitter.android
FrameLayout
  TextView text="For you" [selected]
  TextView text="Following"
"""
        self.assertEqual(selected_top_tab(for_you), "For you")
        self.assertFalse(following_timeline_ready(for_you))

        ambiguous = """NODES display=3 pkg=com.twitter.android
FrameLayout
  TextView text="For you" [selected]
  TextView text="Following" [checked]
"""
        self.assertIsNone(selected_top_tab(ambiguous))
        self.assertFalse(following_timeline_ready(ambiguous))

    def test_readable_x_is_not_automatically_a_timeline(self):
        detail = """NODES display=8 pkg=com.twitter.android
FrameLayout
  ImageButton desc="Navigate up" [clickable]
  TextView text="For you"
  TextView text="Following"
"""
        self.assertTrue(x_tree_ready(detail))
        self.assertFalse(timeline_tree_ready(detail))

        partial = """NODES display=8 pkg=com.twitter.android
FrameLayout
  TextView text="Following"
"""
        self.assertTrue(x_tree_ready(partial))
        self.assertFalse(timeline_tree_ready(partial))

    def test_empty_wrong_package_and_ambiguous_state_fail_closed(self):
        self.assertFalse(x_tree_ready(""))
        self.assertFalse(x_tree_ready("NODES display=8 root=null"))
        self.assertFalse(
            x_tree_ready("NODES display=8 pkg=com.example.reader\nTextView text=\"Following\"\n")
        )
        no_selection = """NODES display=8 pkg=com.twitter.android
TextView text="For you"
TextView text="Following"
"""
        self.assertTrue(timeline_tree_ready(no_selection))
        self.assertIsNone(selected_top_tab(no_selection))
        self.assertFalse(following_timeline_ready(no_selection))


if __name__ == "__main__":
    unittest.main()
