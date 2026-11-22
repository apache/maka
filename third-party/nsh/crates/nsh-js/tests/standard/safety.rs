use super::run;

#[test]
#[cfg(not(target_os = "windows"))]
fn url_module_keeps_native_url_brands_without_replacing_native_web_types() {
    let out = run(r#"
        const constructors = [URL, URLSearchParams, Blob, File, Event, ReadableStream, AbortController];
        const url = await import('url');
        await import('zlib');
        const file = url.pathToFileURL('/你好/a b#%.txt');
        const blob = await new Response('native').blob();
        const originalURL = URL;
        globalThis.URL = function () { throw new Error('replacement constructor must not be used'); };
        const branded = url.pathToFileURL('/a');
        globalThis.URL = originalURL;
        globalThis.out = [url.URL === URL, url.URLSearchParams === URLSearchParams,
            constructors.every((v,i) => v === [URL,URLSearchParams,Blob,File,Event,ReadableStream,AbortController][i]),
            file instanceof URL, file.href, url.fileURLToPath(file), blob instanceof Blob,
            branded instanceof URL];
    "#);
    assert_eq!(
        out,
        r#"[true,true,true,true,"file:///%E4%BD%A0%E5%A5%BD/a%20b%23%25.txt","/%E4%BD%A0%E5%A5%BD/a%20b%23%25.txt",true,true]"#
    );
}

#[test]
#[cfg(not(target_os = "windows"))]
fn url_utilities_match_the_shared_gpui_shell_reference_fixture() {
    let script = format!(
        "import * as url from 'url';\n{}\nglobalThis.out = urlParityFixture(url);",
        include_str!("url-parity.js")
    );
    let actual: serde_json::Value = serde_json::from_str(&run(&script)).unwrap();
    let reference: serde_json::Value =
        serde_json::from_str(include_str!("url-parity.expected.json")).unwrap();
    assert_eq!(
        actual, reference,
        "shared fixture from gpui-shell 0.7.3 (LLRT 7b95c82)"
    );
}

/// Run the same fixture directly in pinned LLRT, without NSH option adaptation.
fn reference_zlib(script: &str) -> String {
    use rquickjs::{
        AsyncContext, AsyncRuntime, Module,
        loader::{BuiltinResolver, ModuleLoader},
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let runtime = AsyncRuntime::new().unwrap();
            runtime
                .set_loader(
                    BuiltinResolver::default()
                        .with_module("buffer")
                        .with_module("zlib"),
                    ModuleLoader::default()
                        .with_module("buffer", quickjs_jit_stdlib::buffer::BufferModule)
                        .with_module("zlib", quickjs_jit_stdlib::zlib::ZlibModule),
                )
                .await;
            let context = AsyncContext::full(&runtime).await.unwrap();
            context
                .async_with(async |cx| {
                    quickjs_jit_stdlib::buffer::init(&cx).unwrap();
                    let module =
                        Module::declare(cx.clone(), "reference-compression.mjs", script).unwrap();
                    let (_, done) = module.eval().unwrap();
                    done.into_future::<()>().await.unwrap();
                    cx.globals().get::<_, String>("referenceOutput").unwrap()
                })
                .await
        })
}

#[test]
fn compression_matches_direct_llrt_under_the_output_ceiling() {
    const SCRIPT: &str = r#"
        import zlib, { gzipSync, gunzipSync, gunzip } from 'zlib';
        import { Buffer } from 'buffer';
        const size = 16 * 1024 * 1024 + 1;
        const packed = gzipSync(Buffer.alloc(size));
        const results = [];
        for (const inflate of [gunzipSync, zlib.gunzipSync]) {
            const decoded = inflate(packed);
            results.push([decoded.length, decoded[0], decoded[size - 1]]);
        }
        for (const inflate of [gunzip, zlib.gunzip]) {
            const decoded = await new Promise((resolve, reject) =>
                inflate(packed, (error, value) => error ? reject(error) : resolve(value)));
            results.push([decoded.length, decoded[0], decoded[size - 1]]);
        }
        const small = gzipSync('hello');
        const explicit = [];
        for (const maxOutputLength of [4, 5, size]) {
            try { explicit.push(gunzipSync(small, {maxOutputLength}).toString()); }
            catch (error) { explicit.push(error.name); }
        }
        for (const maxOutputLength of [4, 5]) {
            explicit.push(await new Promise(resolve => gunzip(small, {maxOutputLength},
                (error, value) => resolve(error ? error.name : value.toString()))));
        }
        globalThis.out = [results, explicit];
        globalThis.referenceOutput = JSON.stringify(globalThis.out);
    "#;
    let expected = reference_zlib(SCRIPT);
    assert_eq!(
        expected,
        r#"[[[16777217,0,0],[16777217,0,0],[16777217,0,0],[16777217,0,0]],["RangeError","hello","hello","RangeError","hello"]]"#
    );
    assert_eq!(run(SCRIPT), expected);
}
