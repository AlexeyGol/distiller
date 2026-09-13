import os
import sys

# WHY: the app modules live flat in sidecar/, one level above tests/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
