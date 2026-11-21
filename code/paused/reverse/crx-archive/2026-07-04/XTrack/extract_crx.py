"""Extract CRX file to source directory.
Supports both CRX2 (simple header) and CRX3 (protobuf header).
Strategy: locate PK\x03\x04 ZIP signature and extract from there.
"""
import zipfile
import os
import struct
import sys
import io

def extract_crx(crx_path, output_dir):
    with open(crx_path, 'rb') as f:
        data = f.read()

    # Find the ZIP local file header signature
    pk_offset = data.find(b'PK\x03\x04')
    if pk_offset == -1:
        print('ERROR: No ZIP signature found — not a valid CRX file?')
        sys.exit(1)

    magic = data[:4]
    version = struct.unpack('<I', data[4:8])[0]
    header_len = struct.unpack('<I', data[8:12])[0]

    print(f'CRX Magic: {magic}')
    print(f'CRX Version: {version}')
    print(f'Header length: {header_len} bytes')
    print(f'ZIP starts at offset: {pk_offset} (0x{pk_offset:x})')

    # Feed ZIP data via BytesIO
    zip_buf = io.BytesIO(data[pk_offset:])
    os.makedirs(output_dir, exist_ok=True)

    with zipfile.ZipFile(zip_buf, 'r') as zf:
        zf.extractall(output_dir)

    # Count files
    file_count = 0
    for root, dirs, files in os.walk(output_dir):
        file_count += len(files)
    print(f'Extracted {file_count} files to {output_dir}')
    return file_count

if __name__ == '__main__':
    crx = sys.argv[1]
    out = sys.argv[2]
    extract_crx(crx, out)
