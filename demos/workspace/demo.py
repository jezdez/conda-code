from importlib.metadata import version
from platform import python_version

from rich.console import Console

console = Console()
console.print("[bold green]\N{CHECK MARK} verify-workspace completed[/]")
console.print(f"Python {python_version()}")
console.print(f"Rich {version('rich')}")
