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

"""Loopback-only SSH acceptance fixture. Requires paramiko; no system sshd changes."""
import json
import os
import pty
import select
import signal
import socket
import subprocess
import threading

import paramiko

password = os.environ.pop("HANDOFF_FIXTURE_PASSWORD")
factor = os.environ.pop("HANDOFF_FIXTURE_FACTOR")
key = paramiko.RSAKey.generate(2048)
stopping = threading.Event()
transports = []


def stop_server(_signal, _frame):
    stopping.set()
    for transport in tuple(transports):
        transport.close()


signal.signal(signal.SIGTERM, stop_server)
signal.signal(signal.SIGINT, stop_server)


class Server(paramiko.ServerInterface):
    def __init__(self):
        self.ready = threading.Event()

    def get_allowed_auths(self, username):
        return "password"

    def check_auth_password(self, username, supplied):
        return paramiko.AUTH_SUCCESSFUL if username == "fixture" and supplied == password else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, *args):
        return True

    def check_channel_shell_request(self, channel):
        self.ready.set()
        return True


def serve(client):
    transport = paramiko.Transport(client)
    transports.append(transport)
    # Natural model discovery plus human entry can take minutes. This fixture
    # must not close the server while the app is legitimately awaiting input.
    transport.auth_timeout = 600
    server = Server()
    child = None
    master = None
    try:
        transport.add_server_key(key)
        transport.start_server(server=server)
        channel = transport.accept(600)
        if channel is None or not server.ready.wait(30):
            return
        master, slave = pty.openpty()
        # Intentionally echo secrets immediately AND after the agent resumes.
        # Neither may reach ordinary Runtime observations or provider requests.
        command = ('stty -echo; printf "Verification code: "; IFS= read -r response; '
                   'test "$response" = "$EXPECTED_FACTOR" || exit 23; '
                   'printf "\\n%s\\nAUTHENTICATED\\n" "$response"; '
                   'marker=original-shell; cd /tmp; '
                   'while IFS= read -r operation; do '
                   'printf "%s\\n" "$response"; eval "$operation"; done')
        child = subprocess.Popen(["/bin/bash", "-c", command], stdin=slave, stdout=slave, stderr=slave,
                                 env={**os.environ, "EXPECTED_FACTOR": factor}, start_new_session=True)
        os.close(slave)
        channel.sendall((password + "\r\n").encode())
        while transport.is_active() and child.poll() is None:
            readable, _, _ = select.select([master, channel], [], [], 1)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                channel.sendall(data)
            if channel in readable:
                data = channel.recv(65536)
                if not data:
                    break
                os.write(master, data)
    finally:
        if child is not None:
            child.terminate()
            child.wait()
        if master is not None:
            os.close(master)
        transport.close()
        transports.remove(transport)


listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(2)
listener.settimeout(0.5)
print(json.dumps({"port": listener.getsockname()[1]}), flush=True)
while not stopping.is_set():
    try:
        client, _ = listener.accept()
    except socket.timeout:
        continue
    threading.Thread(target=serve, args=(client,)).start()
listener.close()
