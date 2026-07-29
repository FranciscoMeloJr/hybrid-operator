import sys
import re
import subprocess
from rich.console import Console
from rich.table import Table
from rich.live import Live
from rich.panel import Panel

from olm_lifecycle import OLMLifecycleAnalyzer

console = Console()
analyzer = OLMLifecycleAnalyzer(ocp_version="4.18")

LOG_PATTERN = re.compile(
    r"->\s+Sub:\s+(?P<sub>\S+)\s+\|\s+Pkg:\s+(?P<pkg>\S+)\s+\|\s+NS:\s+(?P<ns>\S+)\s+\|\s+Channel:\s+(?P<channel>\S+)\s+\|\s+CSV:\s+(?P<csv>\S+)\s+\|\s+Version:\s+(?P<version>\S+)\s+\|\s+Phase:\s+(?P<phase>\S+)"
)

def create_table(operators):
    table = Table(
        title="[bold blue]OpenShift OLM Governance & Lifecycle Projection (OCP 4.18)[/bold blue]",
        expand=True,
        header_style="bold magenta",
    )

    table.add_column("Subscription", style="cyan", no_wrap=True)
    table.add_column("Channel / Ver", style="yellow")
    table.add_column("Phase", justify="center")
    table.add_column("Can Upgrade?", justify="center")
    table.add_column("OCP Supported?", justify="center")
    table.add_column("OCP Upgrade Blocker?", justify="center")

    upgradeable_count = 0
    blocker_count = 0

    for op in operators:
        analysis = analyzer.analyze_operator(op)

        phase = op["phase"]
        phase_styled = f"[bold green]{phase}[/bold green]" if phase == "Succeeded" else f"[bold red blink]{phase}[/bold red blink]"

        # Upgradeable column
        if analysis["can_upgrade"]:
            can_up_str = "[bold cyan]YES[/bold cyan]"
            upgradeable_count += 1
        else:
            can_up_str = "[dim]NO[/dim]"

        # Supported column
        sup_str = "[bold green]YES[/bold green]" if analysis["is_supported"] else "[bold red]NO[/bold red]"

        # Blocker column
        if analysis["must_upgrade_for_ocp"]:
            blocker_str = f"[bold red blink]CRITICAL: {analysis['blocker_reason']}[/bold red blink]"
            blocker_count += 1
        else:
            blocker_str = "[dim green]NO[/dim green]"

        table.add_row(
            op["sub"],
            f"{op['channel']} ({op['version']})",
            phase_styled,
            can_up_str,
            sup_str,
            blocker_str,
        )

    return Panel(
        table,
        subtitle=f"[bold cyan]Upgradeable: {upgradeable_count}[/bold cyan] | [bold red]Upgrade Blockers: {blocker_count}[/bold red] | [bold white]Total: {len(operators)}[/bold white]",
    )

def stream_logs():
    cmd = [
        "oc", "logs", "-f",
        "deployment/hybrid-intelligent-operator",
        "-n", "hybrid-apps",
        "--tail=50"
    ]

    process = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1
    )

    current_operators = []

    with Live(console=console, refresh_per_second=2) as live:
        for line in process.stdout:
            if "Running OLM operator inventory sweep..." in line:
                current_operators = []
            
            match = LOG_PATTERN.search(line)
            if match:
                current_operators.append(match.groupdict())
                live.update(create_table(current_operators))

if __name__ == "__main__":
    try:
        stream_logs()
    except KeyboardInterrupt:
        console.print("\n[bold red]Exiting governance viewer.[/bold red]")
        sys.exit(0)