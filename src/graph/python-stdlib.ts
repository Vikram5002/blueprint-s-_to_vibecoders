/**
 * Python standard library module names.
 *
 * There is no runtime to interrogate — the tool analyses repositories, it does
 * not execute them, and the target repo may not even have a Python interpreter
 * available. So the list is explicit, as PHASE-1-SPEC requires.
 *
 * Derived from `sys.stdlib_module_names` (CPython 3.12), which is a superset of
 * older versions for our purposes: modules removed in 3.12 are still listed
 * because repositories written for older Pythons import them, and a name that
 * was stdlib then is not a third-party dependency now.
 *
 * Matching is on the TOP-LEVEL package only: `xml.etree.ElementTree` is stdlib
 * because `xml` is.
 */
const STANDARD_LIBRARY_MODULES: ReadonlySet<string> = new Set([
  '__future__', '_abc', '_aix_support', '_ast', '_asyncio', '_bisect', '_blake2', '_bootsubprocess',
  '_bz2', '_codecs', '_codecs_cn', '_codecs_hk', '_codecs_iso2022', '_codecs_jp', '_codecs_kr',
  '_codecs_tw', '_collections', '_collections_abc', '_compat_pickle', '_compression', '_contextvars',
  '_csv', '_ctypes', '_curses', '_curses_panel', '_datetime', '_dbm', '_decimal', '_elementtree',
  '_frozen_importlib', '_frozen_importlib_external', '_functools', '_gdbm', '_hashlib', '_heapq',
  '_imp', '_io', '_json', '_locale', '_lsprof', '_lzma', '_markupbase', '_md5', '_msi',
  '_multibytecodec', '_multiprocessing', '_opcode', '_operator', '_osx_support', '_overlapped',
  '_pickle', '_posixshmem', '_posixsubprocess', '_py_abc', '_pydecimal', '_pyio', '_queue', '_random',
  '_sha1', '_sha256', '_sha3', '_sha512', '_signal', '_sitebuiltins', '_socket', '_sqlite3', '_sre',
  '_ssl', '_stat', '_statistics', '_string', '_strptime', '_struct', '_symtable', '_thread',
  '_threading_local', '_tkinter', '_tokenize', '_tracemalloc', '_typing', '_uuid', '_warnings',
  '_weakref', '_weakrefset', '_winapi', '_zoneinfo',
  'abc', 'aifc', 'antigravity', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore',
  'atexit', 'audioop', 'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2',
  'cProfile', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs', 'codeop',
  'collections', 'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib', 'contextvars',
  'copy', 'copyreg', 'crypt', 'csv', 'ctypes', 'curses',
  'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'distutils', 'doctest',
  'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput',
  'fnmatch', 'fractions', 'ftplib', 'functools',
  'gc', 'genericpath', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip',
  'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr', 'imp', 'importlib',
  'inspect', 'io', 'ipaddress', 'itertools',
  'json', 'keyword', 'lib2to3', 'linecache', 'locale', 'logging', 'lzma',
  'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msilib', 'msvcrt',
  'multiprocessing', 'netrc', 'nis', 'nntplib', 'nt', 'ntpath', 'nturl2path', 'numbers',
  'opcode', 'operator', 'optparse', 'os', 'ossaudiodev',
  'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib',
  'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc',
  'pydoc_data', 'pyexpat',
  'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy',
  'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site',
  'sitecustomize', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'sre_compile',
  'sre_constants', 'sre_parse', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct',
  'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog',
  'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'textwrap', 'this', 'threading', 'time',
  'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty',
  'turtle', 'turtledemo', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uu', 'uuid',
  'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref',
  'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

/** True when the module's top-level package is part of the standard library. */
export function isStandardLibraryModule(moduleName: string): boolean {
  if (moduleName === '') {
    return false;
  }
  const topLevel = moduleName.split('.')[0] ?? '';
  return STANDARD_LIBRARY_MODULES.has(topLevel);
}
