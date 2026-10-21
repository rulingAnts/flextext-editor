"""PyInstaller entry point for the portable fxdiag executable."""
import sys

from fxdiag.cli import main

if __name__ == "__main__":
    sys.exit(main())
