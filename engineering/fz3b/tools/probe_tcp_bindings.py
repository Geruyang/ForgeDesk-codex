"""Fixed passive listener inspection; no network or service operations."""
import json
import socket
import struct

rows = []
for family in ('tcp', 'tcp6'):
    with open('/proc/net/' + family, 'r') as stream:
        text = stream.read(1024 * 1024 + 1)
    if len(text) > 1024 * 1024:
        raise ValueError('TCP metadata bound exceeded')
    for line in text.splitlines()[1:]:
        fields = line.split()
        address, port = fields[1].split(':')
        if int(port, 16) not in (8765, 8766) or fields[3] != '0A':
            continue
        if family == 'tcp':
            ip = socket.inet_ntop(socket.AF_INET, struct.pack('<I', int(address, 16)))
        else:
            ip = socket.inet_ntop(socket.AF_INET6, b''.join(struct.pack('<I', int(address[i:i+8], 16)) for i in range(0, 32, 8)))
        rows.append({'address': ip, 'port': int(port, 16), 'family': family})
expected = [{'address': '127.0.0.1', 'port': port, 'family': 'tcp'} for port in (8765, 8766)]
passed = sorted(rows, key=lambda item: item['port']) == expected
print(json.dumps({'scope': 'passive control/video TCP listener addresses', 'passed': passed, 'listeners': rows, 'writes': False}))
raise SystemExit(0 if passed else 1)
