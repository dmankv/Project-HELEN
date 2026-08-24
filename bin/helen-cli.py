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
            print("Dependencies not installed. Running npm ci --legacy-peer-deps...")
            subprocess.run(['npm', 'ci', '--legacy-peer-deps'], check=True)
        
        # Run TypeScript CLI via tsx from root dependencies
        print("Starting HELEN CLI...\n")
        subprocess.run(['npx', 'tsx', 'src/cli/helen-cli.ts', *sys.argv[1:]], check=False)
    
    except KeyboardInterrupt:
        print("\n\nHELEN CLI terminated.")
        sys.exit(0)
    except Exception as e:
        print(f"Error: {e}")
        print("Make sure you have Node.js and npm installed.")
        sys.exit(1)

if __name__ == '__main__':
    main()
