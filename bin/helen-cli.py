#!/usr/bin/env python3
"""
CLI Wrapper for HELEN Text Interface
Provides a simple command to run the text-based interface.
"""

import subprocess
import sys
import os

def main():
    """Run HELEN CLI interface."""
    try:
        # Check if node_modules exist
        if not os.path.exists('node_modules'):
            print("Dependencies not installed. Running npm install...")
            subprocess.run(['npm', 'install'], check=True)
        
        # Build TypeScript if needed
        print("Starting HELEN CLI...\n")
        subprocess.run(['npx', 'ts-node', 'src/cli/helen-cli.ts'], check=False)
    
    except KeyboardInterrupt:
        print("\n\nHELEN CLI terminated.")
        sys.exit(0)
    except Exception as e:
        print(f"Error: {e}")
        print("Make sure you have Node.js and npm installed.")
        sys.exit(1)

if __name__ == '__main__':
    main()
