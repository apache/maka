/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use std::{
    env,
    fs::OpenOptions,
    io::{self, Write},
    process, thread,
};

fn main() -> io::Result<()> {
    // EOF must release even a process still blocked in File::lock.
    thread::spawn(|| {
        if let Err(error) = io::copy(&mut io::stdin().lock(), &mut io::sink()) {
            eprintln!("archive lock stdin: {error}");
            process::exit(1);
        }
        process::exit(0);
    });
    let path = env::args_os()
        .nth(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "expected lock path"))?;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    file.lock()?;
    writeln!(io::stdout(), "acquired")?;
    io::stdout().flush()?;
    loop {
        thread::park();
    }
}
