# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
"""HTTP request framing accepted by the loopback provider fixture."""

import asyncio
import unittest

from compare import request_body


def stream(data):
    reader = asyncio.StreamReader()
    reader.feed_data(data)
    reader.feed_eof()
    return reader


class RequestBodyTests(unittest.IsolatedAsyncioTestCase):
    async def test_content_length_preserves_following_bytes(self):
        reader = stream(b'{"ok":true}next')
        self.assertEqual(
            await request_body(reader, {"cOnTeNt-LeNgTh": " 11 "}), b'{"ok":true}'
        )
        self.assertEqual(await reader.read(), b"next")

    async def test_chunk_extensions_trailers_and_unicode(self):
        reader = stream(
            b"3;fixture=yes\r\n\xe4\xb8\xad\r\n4\r\ntext\r\n"
            b"0\r\nX-Fixture: done\r\n\r\nnext"
        )
        self.assertEqual(
            await request_body(reader, {"Transfer-Encoding": " ChUnKeD "}),
            "中text".encode(),
        )
        self.assertEqual(await reader.read(), b"next")

    async def test_unframed_request_is_empty(self):
        reader = stream(b"next")
        self.assertEqual(await request_body(reader, {}), b"")
        self.assertEqual(await reader.read(), b"next")

    async def test_ambiguous_or_unsupported_framing_fails(self):
        for fields in (
            {"Transfer-Encoding": "chunked", "Content-Length": "3"},
            {"Transfer-Encoding": "gzip, chunked"},
        ):
            with (
                self.subTest(fields=fields),
                self.assertRaisesRegex(
                    ValueError, "unsupported or ambiguous request framing"
                ),
            ):
                await request_body(stream(b""), fields)

    async def test_malformed_or_truncated_chunks_fail(self):
        for wire, error in (
            (b"not-hex\r\n", ValueError),
            (b"3\r\nabcXX", ValueError),
            (b"3\r\nab", asyncio.IncompleteReadError),
            (b"0\r\nX-Fixture: done\r\n", asyncio.IncompleteReadError),
        ):
            with self.subTest(wire=wire), self.assertRaises(error):
                await request_body(stream(wire), {"Transfer-Encoding": "chunked"})


if __name__ == "__main__":
    unittest.main()
