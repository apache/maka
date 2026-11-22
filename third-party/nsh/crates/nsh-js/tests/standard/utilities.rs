use super::run;

#[test]
fn buffers_round_trip_cjk_and_binary_without_losing_zero_bytes() {
    let out = run(r#"
        import { Buffer } from 'buffer';
        const text = Buffer.from('你好 🌍', 'utf8');
        const binary = Buffer.from([0, 255, 128, 65]);
        const decoded = Buffer.from(binary.toString('base64'), 'base64');
        globalThis.out = [text.toString('utf8'), Buffer.byteLength('你好 🌍'),
            binary.toString('hex'), decoded.toString('hex'),
            Buffer.concat([Buffer.from([0]), text]).subarray(1).toString(),
            Buffer.isBuffer(text), Buffer.isBuffer(new Uint8Array(2))];
    "#);
    assert_eq!(
        out,
        r#"["你好 🌍",11,"00ff8041","00ff8041","你好 🌍",true,false]"#
    );
}

#[test]
fn buffer_views_share_storage_and_endian_access_preserves_bytes() {
    let out = run(r#"
        import { Buffer } from 'buffer';
        const bytes = Buffer.alloc(6);
        bytes.writeUInt32BE(0x12345678, 1);
        const view = bytes.subarray(1, 5);
        view[0] = 0xab;
        globalThis.out = [bytes.toString('hex'), view.readUInt32BE(0),
            view.readUInt32LE(0), view.length, bytes[0], bytes[5]];
    "#);
    assert_eq!(out, r#"["00ab34567800",2872333944,2018915499,4,0,0]"#);
}

#[test]
#[cfg(not(windows))]
fn path_operations_normalize_without_touching_the_filesystem() {
    // LLRT d9fd873e strips trailing separators in normalize unlike Node.
    // Keep this basic shared contract independent of that upstream limitation.
    let out = run(r#"
        import path from 'path';
        const parsed = path.parse('/workspace/你好/report.test.md');
        globalThis.out = [path.join('/workspace', 'a', '..', '你好', 'report.md'),
            path.normalize('/a//b/../c'), path.basename('/a/report.test.md', '.md'),
            path.dirname('/a/report.test.md'), path.extname('.gitignore'),
            path.relative('/a/b', '/a/c/report.md'), path.isAbsolute('/a'),
            path.format(parsed), path.sep, path.delimiter];
    "#);
    assert_eq!(
        out,
        r#"["/workspace/你好/report.md","/a/c","report.test","/a","","../c/report.md",true,"/workspace/你好/report.test.md","/",":"]"#
    );
}

#[test]
fn url_query_duplicates_unicode_and_relative_resolution() {
    let out = run(r#"
        import { URL, URLSearchParams, domainToASCII, domainToUnicode } from 'url';
        const url = new URL('../你好?q=a+b&q=c%26d#part', 'https://example.com/a/b/');
        const params = new URLSearchParams(url.search);
        const before = params.getAll('q');
        params.set('q', '中文 &');
        params.append('empty', '');
        globalThis.out = [url.pathname, before, params.toString(), url.origin,
            domainToASCII('例え.jp'), domainToUnicode('xn--r8jz45g.jp')];
    "#);
    assert_eq!(
        out,
        r#"["/a/%E4%BD%A0%E5%A5%BD",["a b","c&d"],"q=%E4%B8%AD%E6%96%87+%26&empty=","https://example.com","xn--r8jz45g.jp","例え.jp"]"#
    );
}

#[test]
fn crypto_sha256_and_hmac_match_known_vectors_with_chunked_updates() {
    let out = run(r#"
        import { createHash, createHmac } from 'crypto';
        import { Buffer } from 'buffer';
        const hash = createHash('sha256').update('a').update(Buffer.from('bc')).digest('hex');
        const empty = createHash('sha256').digest('hex');
        const hmac = createHmac('sha256', 'key')
            .update('The quick brown fox jumps over the lazy dog').digest('hex');
        globalThis.out = [hash, empty, hmac];
    "#);
    assert_eq!(
        out,
        r#"["ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"]"#
    );
}

#[test]
fn zlib_decodes_known_gzip_and_round_trips_cjk_and_binary() {
    let out = run(r#"
        import { gzipSync, gunzipSync, deflateSync, inflateSync,
            deflateRawSync, inflateRawSync } from 'zlib';
        import { Buffer } from 'buffer';
        const source = Buffer.concat([Buffer.from('你好 🌍'), Buffer.from([0, 255, 128])]);
        const known = Buffer.from('1f8b08000000000002034b4c4a0600c241243503000000', 'hex');
        const compressed = gzipSync(source);
        globalThis.out = [gunzipSync(known).toString(), compressed[0], compressed[1],
            gunzipSync(compressed).toString('hex'),
            inflateSync(deflateSync(source)).toString('hex'),
            inflateRawSync(deflateRawSync(source)).toString('hex')];
    "#);
    assert_eq!(
        out,
        r#"["abc",31,139,"e4bda0e5a5bd20f09f8c8d00ff80","e4bda0e5a5bd20f09f8c8d00ff80","e4bda0e5a5bd20f09f8c8d00ff80"]"#
    );
}

#[test]
fn webcrypto_digest_settles_in_the_same_vm_and_honors_view_bounds() {
    let out = run(r#"
        import { webcrypto } from 'crypto';
        import { Buffer } from 'buffer';
        const backing = new Uint8Array([0xff, 97, 98, 99, 0xff]);
        const digest = await webcrypto.subtle.digest('SHA-256', backing.subarray(1, 4));
        globalThis.out = [digest.byteLength, Buffer.from(digest).toString('hex')];
    "#);
    assert_eq!(
        out,
        r#"[32,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]"#
    );
}

#[test]
fn zlib_callback_settles_once_with_binary_result_in_the_same_vm() {
    let out = run(r#"
        import { gzip, gunzipSync } from 'zlib';
        import { Buffer } from 'buffer';
        let calls = 0;
        const result = await new Promise((resolve, reject) => {
            gzip(Buffer.from([0, 255, 128, 65]), (error, data) => {
                calls++;
                if (error) reject(error); else resolve(data);
            });
        });
        globalThis.out = [calls, Buffer.isBuffer(result), gunzipSync(result).toString('hex')];
    "#);
    assert_eq!(out, r#"[1,true,"00ff8041"]"#);
}
