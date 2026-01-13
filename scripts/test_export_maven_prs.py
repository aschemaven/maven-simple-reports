#!/usr/bin/env python3
#
# Copyright 2026 The Apache Software Foundation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
"""
Unit tests for export_maven_prs.py
"""
import unittest
from export_maven_prs import get_build_status


class TestGetBuildStatus(unittest.TestCase):
    """Tests for the get_build_status function"""

    def _make_pr(self, rollup=None, mergeable='MERGEABLE'):
        """Helper to create a minimal PR object for testing"""
        return {
            'repository': {'name': 'maven-test'},
            'number': 123,
            'url': 'https://github.com/apache/maven-test/pull/123',
            'statusCheckRollup': rollup,
            'mergeable': mergeable,
        }

    # --- Merge conflict tests ---

    def test_merge_conflict_returns_conflict(self):
        """PR with merge conflict should return CONFLICT status"""
        pr = self._make_pr(
            rollup=[{'state': 'COMPLETED', 'conclusion': 'SUCCESS'}],
            mergeable='CONFLICTING'
        )
        status, url = get_build_status(pr)
        self.assertEqual(status, 'CONFLICT')
        self.assertEqual(url, pr['url'])

    # --- Empty/missing rollup tests ---

    def test_no_rollup_returns_unknown(self):
        """PR with no statusCheckRollup should return UNKNOWN"""
        pr = self._make_pr(rollup=None)
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'UNKNOWN')

    def test_empty_rollup_returns_unknown(self):
        """PR with empty statusCheckRollup should return UNKNOWN"""
        pr = self._make_pr(rollup=[])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'UNKNOWN')

    # --- Single check tests ---

    def test_completed_success_returns_success(self):
        """Check with state=COMPLETED and conclusion=SUCCESS should return SUCCESS"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'SUCCESS')

    def test_completed_failure_returns_failure(self):
        """Check with state=COMPLETED and conclusion=FAILURE should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'FAILURE'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_completed_cancelled_returns_failure(self):
        """Check with state=COMPLETED and conclusion=CANCELLED should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'CANCELLED'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_completed_timed_out_returns_failure(self):
        """Check with state=COMPLETED and conclusion=TIMED_OUT should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'TIMED_OUT'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_completed_startup_failure_returns_failure(self):
        """Check with state=COMPLETED and conclusion=STARTUP_FAILURE should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'STARTUP_FAILURE'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_completed_without_conclusion_returns_unknown(self):
        """Check with state=COMPLETED but no conclusion should return UNKNOWN"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'UNKNOWN')

    def test_in_progress_returns_pending(self):
        """Check with state=IN_PROGRESS should return PENDING"""
        pr = self._make_pr(rollup=[
            {'state': 'IN_PROGRESS'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'PENDING')

    def test_queued_returns_pending(self):
        """Check with state=QUEUED should return PENDING"""
        pr = self._make_pr(rollup=[
            {'state': 'QUEUED'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'PENDING')

    def test_waiting_returns_pending(self):
        """Check with state=WAITING should return PENDING"""
        pr = self._make_pr(rollup=[
            {'state': 'WAITING'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'PENDING')

    def test_pending_state_returns_pending(self):
        """Check with state=PENDING should return PENDING"""
        pr = self._make_pr(rollup=[
            {'state': 'PENDING'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'PENDING')

    # --- StatusContext tests (commit status API) ---

    def test_status_context_success(self):
        """StatusContext with state=SUCCESS should return SUCCESS"""
        pr = self._make_pr(rollup=[
            {'state': 'SUCCESS'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'SUCCESS')

    def test_status_context_failure(self):
        """StatusContext with state=FAILURE should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'FAILURE'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_status_context_error(self):
        """StatusContext with state=ERROR should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'ERROR'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_status_context_pending(self):
        """StatusContext with state=PENDING should return PENDING"""
        pr = self._make_pr(rollup=[
            {'state': 'PENDING'}
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'PENDING')

    # --- Mixed checks tests (priority: failure > pending > success) ---

    def test_mixed_success_and_pending_returns_pending(self):
        """Mixed SUCCESS and IN_PROGRESS checks should return PENDING"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'},
            {'state': 'IN_PROGRESS'},
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'PENDING')

    def test_mixed_success_and_failure_returns_failure(self):
        """Mixed SUCCESS and FAILURE checks should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'},
            {'state': 'COMPLETED', 'conclusion': 'FAILURE'},
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_mixed_pending_and_failure_returns_failure(self):
        """Mixed PENDING and FAILURE checks should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'IN_PROGRESS'},
            {'state': 'COMPLETED', 'conclusion': 'FAILURE'},
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_mixed_all_states_returns_failure(self):
        """Mixed SUCCESS, PENDING, and FAILURE checks should return FAILURE"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'},
            {'state': 'IN_PROGRESS'},
            {'state': 'COMPLETED', 'conclusion': 'FAILURE'},
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'FAILURE')

    def test_multiple_success_returns_success(self):
        """Multiple SUCCESS checks should return SUCCESS"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'},
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'},
            {'state': 'SUCCESS'},  # StatusContext style
        ])
        status, _ = get_build_status(pr)
        self.assertEqual(status, 'SUCCESS')

    # --- Bug regression test ---

    def test_completed_not_treated_as_success(self):
        """COMPLETED state alone should NOT be treated as success (regression test)

        This is the bug that was reported: checks with state=COMPLETED but
        conclusion=FAILURE were incorrectly shown as SUCCESS because COMPLETED
        was in the success states list.
        """
        # Scenario: One check completed with failure, one still running
        # Old buggy code would see COMPLETED and mark as success
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'FAILURE'},
            {'state': 'IN_PROGRESS'},
        ])
        status, _ = get_build_status(pr)
        # Should be FAILURE, not SUCCESS
        self.assertEqual(status, 'FAILURE')

    def test_in_progress_with_completed_success_returns_pending(self):
        """Some checks done (success), some still running → PENDING (regression test)

        This was the reported bug: shows SUCCESS even though some jobs not finished.
        """
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'},
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'},
            {'state': 'IN_PROGRESS'},  # Still running!
        ])
        status, _ = get_build_status(pr)
        # Should be PENDING because one job is still running
        self.assertEqual(status, 'PENDING')

    # --- URL generation tests ---

    def test_checks_url_generated_correctly(self):
        """Build URL should point to PR checks page"""
        pr = self._make_pr(rollup=[
            {'state': 'COMPLETED', 'conclusion': 'SUCCESS'}
        ])
        _, url = get_build_status(pr)
        self.assertEqual(url, 'https://github.com/apache/maven-test/pull/123/checks')

    def test_conflict_url_points_to_pr(self):
        """Conflict status should return PR URL (not checks URL)"""
        pr = self._make_pr(
            rollup=[{'state': 'COMPLETED', 'conclusion': 'SUCCESS'}],
            mergeable='CONFLICTING'
        )
        _, url = get_build_status(pr)
        self.assertEqual(url, 'https://github.com/apache/maven-test/pull/123')


if __name__ == '__main__':
    unittest.main()
