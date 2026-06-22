"""Folder keypoint ordering and pose sequence generation from folder refs."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from services import reference_storage
from services.logic import generate_pose_sequence_from_folder_ref


class ListFolderKeypointsOrderedTests(unittest.TestCase):
    def test_nested_folder_order(self) -> None:
        entries = [
            {"id": "kp_a", "keypointRelPath": "references/keypoints/a_kp.png"},
            {"id": "kp_b", "keypointRelPath": "references/keypoints/b_kp.png"},
        ]
        layout = {
            "folders": [
                {"id": "parent", "name": "Parent"},
                {"id": "child", "name": "Child", "parentId": "parent"},
            ],
            "folderOrder": {
                "parent": ["folder:child", "kp_b"],
                "child": ["kp_a"],
            },
        }
        with patch(
            "services.reference_storage.list_keypoints", return_value=entries
        ), patch(
            "services.reference_storage._sync_ui_layout_with_keypoints",
            return_value=layout,
        ):
            ordered = reference_storage.list_folder_keypoints_ordered("parent")
        self.assertEqual([e["id"] for e in ordered], ["kp_a", "kp_b"])

    def test_empty_folder_raises(self) -> None:
        layout = {
            "folders": [{"id": "empty", "name": "Empty"}],
            "folderOrder": {"empty": []},
        }
        with patch("services.reference_storage.list_keypoints", return_value=[]), patch(
            "services.reference_storage._sync_ui_layout_with_keypoints",
            return_value=layout,
        ):
            with self.assertRaises(ValueError):
                reference_storage.list_folder_keypoints_ordered("empty")

    def test_missing_folder_raises(self) -> None:
        with patch("services.reference_storage.list_keypoints", return_value=[]), patch(
            "services.reference_storage._sync_ui_layout_with_keypoints",
            return_value={"folders": [], "folderOrder": {}},
        ):
            with self.assertRaises(ValueError):
                reference_storage.list_folder_keypoints_ordered("nope")


class GeneratePoseSequenceFromFolderRefTests(unittest.TestCase):
    def test_delegates_to_shared_generator(self) -> None:
        kp_entries = [
            {"id": "kp1", "keypointRelPath": "references/keypoints/1.png"},
            {"id": "kp2", "keypointRelPath": "references/keypoints/2.png"},
        ]
        with patch(
            "services.reference_storage.list_folder_keypoints_ordered",
            return_value=kp_entries,
        ), patch(
            "services.reference_storage.get_keypoints_layout",
            return_value={"folders": [{"id": "fid", "name": "Motion"}]},
        ), patch(
            "services.logic._keypoint_storage_rel_to_abs",
            side_effect=lambda p: f"/abs/{p}",
        ), patch(
            "services.logic.generate_pose_sequence_from_keypoints",
            return_value={"sequenceName": "folder_motion_1", "galleryItemId": "g1"},
        ) as gen:
            result = generate_pose_sequence_from_folder_ref(
                "hero",
                "fid",
                "/base.png",
                ["jogging"],
            )
        self.assertEqual(result["sequenceName"], "folder_motion_1")
        gen.assert_called_once()
        kwargs = gen.call_args.kwargs
        self.assertEqual(kwargs["seq_name_prefix"], "folder_Motion")
        self.assertEqual(kwargs["gallery_subdir_prefix"], "posefolder")
        self.assertEqual(gen.call_args.args[1], ["/abs/references/keypoints/1.png", "/abs/references/keypoints/2.png"])


if __name__ == "__main__":
    unittest.main()
