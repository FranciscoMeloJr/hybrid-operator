import re
from typing import Dict, Any

class OLMLifecycleAnalyzer:
    def __init__(self, ocp_version: str = "4.18"):
        """
        :param ocp_version: Target/Current OpenShift Version (e.g., '4.18')
        """
        self.ocp_version = ocp_version

    def parse_semver(self, version_str: str):
        """Extracts major.minor.patch tuple from raw CSV/Version strings."""
        match = re.search(r"(\d+)\.(\d+)\.(\d+)", version_str)
        if match:
            return tuple(map(int, match.groups()))
        return (0, 0, 0)

    def analyze_operator(self, op: Dict[str, str]) -> Dict[str, Any]:
        """
        Evaluates upgrade eligibility, OCP compatibility, and blocker status.
        """
        name = op.get("sub", op.get("name", ""))
        channel = op.get("channel", "")
        csv = op.get("csv", op.get("installedCSV", ""))
        version = op.get("version", "0.0.0")
        phase = op.get("phase", "Unknown")

        # Extract numerical version
        v_tuple = self.parse_semver(version)

        # 1. CAN BE UPGRADED
        # Flagged if Phase is Succeeded BUT CSV name doesn't match the channel's latest pattern
        # or if channel indicates a legacy version stream.
        can_upgrade = False
        upgrade_target = "N/A"

        if phase == "Succeeded":
            # Example heuristic: If channel specifies a higher minor version than current CSV
            channel_v_match = re.search(r"(\d+)\.(\d+)", channel)
            if channel_v_match:
                chan_major, chan_minor = map(int, channel_v_match.groups())
                if (chan_major, chan_minor) > (v_tuple[0], v_tuple[1]):
                    can_upgrade = True
                    upgrade_target = f"Channel {channel} Head"
            elif "stable" in channel or "latest" in channel:
                # Flag candidate for patch/minor upgrades on rolling channels
                can_upgrade = True
                upgrade_target = f"Latest in {channel}"

        # 2. SUPPORTED ON THIS OCP VERSION
        # Evaluates if operator is supported on current OCP version
        is_supported = True
        support_note = f"Supported on OCP {self.ocp_version}"

        if phase == "Failed":
            is_supported = False
            support_note = "Installation Failed / Incompatible"
        elif "alpha" in channel:
            support_note = "Tech Preview / Alpha Channel"

        # 3. MUST BE UPGRADED FOR NEXT OCP UPGRADE
        # Blocker logic: If operator is on an EOL channel/version or currently Failed
        must_upgrade_for_ocp = False
        blocker_reason = "None"

        if phase == "Failed":
            must_upgrade_for_ocp = True
            blocker_reason = "Operator in Failed state blocks OCP payload update"
        elif v_tuple < (1, 0, 0) and phase == "Succeeded":
            must_upgrade_for_ocp = True
            blocker_reason = f"Legacy 0.x version ({version}) unsupported on OCP {self.ocp_version}+"

        return {
            "can_upgrade": can_upgrade,
            "upgrade_target": upgrade_target,
            "is_supported": is_supported,
            "support_note": support_note,
            "must_upgrade_for_ocp": must_upgrade_for_ocp,
            "blocker_reason": blocker_reason,
        }