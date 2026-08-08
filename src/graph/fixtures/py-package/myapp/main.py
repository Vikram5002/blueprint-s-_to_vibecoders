import os
import sys
import myapp.helpers
import myapp.sub.deep as deep
from myapp.helpers import helper
from . import helpers
from .helpers import helper as h2
from .sub import deep as d2
from .sub.deep import thing
from ..outside import nope
from x_missing import gone
from typing import (
    Any,
    Optional,
)
import numpy as np
import requests

try:
    import ujson as json_impl
except ImportError:
    import json as json_impl

if False:
    from .helpers import lazy
