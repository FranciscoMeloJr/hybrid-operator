import json
import logging
import re
import subprocess
from typing import Any, Dict, Tuple

logger = logging.getLogger("olm-catalog")


class CatalogService:
    """Interacts with OpenShift PackageManifest API to discover catalog channel heads."""

    @staticmethod
    def parse_semver(version_str: str) -> Tuple[int, int, int]:
        match = re.search(r"(\d+)\.(\d+)\.(\d+)", str(version_str))
        if match:
            return tuple(map(int, match.groups()))
        return (0, 0, 0)

    def get_package_manifest(
        self, pkg_name: str, namespace: str
    ) -> Dict[str, Any] | None:
        cmd = [
            "oc",
            "get",
            "packagemanifest",
            pkg_name,
            "-n",
            namespace,
            "-o",
            "json",
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if res.returncode == 0:
                return json.loads(res.stdout)
        except Exception as e:
            logger.warning(f"Failed to fetch PackageManifest for {pkg_name}: {e}")
        return None

    def evaluate_target(
        self, pkg: str, ns: str, channel: str, installed_version: str
    ) -> Dict[str, Any]:
        manifest = self.get_package_manifest(pkg, ns)
        if not manifest:
            return {
                "target_version": installed_version,
                "can_upgrade": False,
                "upgrade_type": "UNKNOWN",
                "catalog_status": "MANIFEST_NOT_FOUND",
            }

        channels = manifest.get("status", {}).get("channels", [])
        target_ch = next(
            (c for c in channels if c.get("name") == channel), None
        )

        if not target_ch:
            return {
                "target_version": installed_version,
                "can_upgrade": False,
                "upgrade_type": "UNKNOWN",
                "catalog_status": "CHANNEL_NOT_FOUND",
            }

        current_csv_desc = target_ch.get("currentCSVDesc", {})
        target_version = current_csv_desc.get("version", installed_version)

        inst_v = self.parse_semver(installed_version)
        targ_v = self.parse_semver(target_version)

        can_upgrade = targ_v > inst_v
        upgrade_type = "NONE"
        if can_upgrade:
            if targ_v[0] > inst_v[0]:
                upgrade_type = "MAJOR"
            elif targ_v[1] > inst_v[1]:
                upgrade_type = "MINOR"
            else:
                upgrade_type = "PATCH"

        return {
            "target_version": target_version,
            "target_csv": current_csv_desc.get("name", ""),
            "can_upgrade": can_upgrade,
            "upgrade_type": upgrade_type,
            "catalog_status": "OK",
        }