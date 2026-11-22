//! `fetch` on Java's `HttpURLConnection` (`Net.java`), which honors the
//! system's proxy and trust store settings. Java reports each request's
//! head, body chunks, end or failure (and, for a streamed body, when it
//! wants the next chunk) to the natives here, on its pooled threads.

use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicI64, Ordering},
};

use jni::{
    JNIEnv,
    objects::{JByteArray, JClass, JObject, JObjectArray, JString, JValue},
    signature::{Primitive, ReturnType},
    sys::{jboolean, jint, jlong},
};
use nsh_engine::{FetchEvent, FetchEvents, FetchTask, HttpBody, HttpHead, HttpRequest, Network};
use rustc_hash::FxHashMap;

use crate::java::{java, with_env};

/// Where the requests in flight report, by key.
static PENDING: Mutex<Option<FxHashMap<i64, FetchEvents>>> = Mutex::new(None);
static NEXT: AtomicI64 = AtomicI64::new(1);

pub(crate) fn network() -> Arc<dyn Network> {
    static NETWORK: OnceLock<Arc<JavaNetwork>> = OnceLock::new();
    NETWORK.get_or_init(|| Arc::new(JavaNetwork)).clone()
}

struct JavaNetwork;

/// Reports `event` of request `key` (dropped once the request is done or
/// cancelled).
fn report(key: i64, event: FetchEvent) {
    let mut pending = PENDING.lock().expect("pending");
    let Some(map) = pending.as_mut() else { return };
    let done = matches!(event, FetchEvent::End | FetchEvent::Failed(_));
    if let Some(events) = map.get_mut(&key) {
        events(event);
    }
    if done {
        map.remove(&key);
    }
}

/// Calls static `Net` method `method` with `args` (references that live
/// until the call: the local frame of `with_env` frees them).
fn call_net(
    env: &mut JNIEnv<'_>,
    method: jni::objects::JStaticMethodID,
    args: &[jni::sys::jvalue],
) -> jni::errors::Result<()> {
    let j = java();
    // SAFETY: each caller passes the arguments of the signature checked in
    // `java::init`.
    unsafe {
        env.call_static_method_unchecked(
            <&JClass<'_>>::from(j.net.as_obj()),
            method,
            ReturnType::Primitive(Primitive::Void),
            args,
        )
    }
    .map(|_| ())
}

struct Task {
    key: i64,
}

impl FetchTask for Task {
    fn send(&mut self, chunk: Vec<u8>) {
        let key = self.key;
        with_env(|env| {
            let bytes = env.byte_array_from_slice(&chunk)?;
            let args = [JValue::Long(key).as_jni(), JValue::Object(&bytes).as_jni()];
            call_net(env, java().net_send, &args)
        });
    }

    fn finish(&mut self) {
        let key = self.key;
        with_env(|env| call_net(env, java().net_finish, &[JValue::Long(key).as_jni()]));
    }

    fn pause(&mut self, paused: bool) {
        let key = self.key;
        with_env(|env| {
            let args = [
                JValue::Long(key).as_jni(),
                JValue::Bool(paused.into()).as_jni(),
            ];
            call_net(env, java().net_pause, &args)
        });
    }

    fn cancel(self: Box<Self>) {
        // Dropping the callback: late events are ignored.
        if let Some(map) = PENDING.lock().expect("pending").as_mut() {
            map.remove(&self.key);
        }
        let key = self.key;
        with_env(|env| call_net(env, java().net_cancel, &[JValue::Long(key).as_jni()]));
    }
}

impl Network for JavaNetwork {
    fn fetch(&self, request: HttpRequest, events: FetchEvents) -> Box<dyn FetchTask> {
        let key = NEXT.fetch_add(1, Ordering::Relaxed);
        PENDING
            .lock()
            .expect("pending")
            .get_or_insert_with(FxHashMap::default)
            .insert(key, events);
        with_env(|env| {
            let j = java();
            let method = env.new_string(&request.method)?;
            let url = env.new_string(&request.url)?;
            let headers = env.new_object_array(
                (request.headers.len() * 2) as i32,
                "java/lang/String",
                JObject::null(),
            )?;
            for (i, (k, v)) in request.headers.iter().enumerate() {
                let k = env.new_string(k)?;
                let v = env.new_string(v)?;
                env.set_object_array_element(&headers, (i * 2) as i32, k)?;
                env.set_object_array_element(&headers, (i * 2 + 1) as i32, v)?;
            }
            let body = match &request.body {
                HttpBody::Bytes(bytes) if !bytes.is_empty() => {
                    JObject::from(env.byte_array_from_slice(bytes)?)
                }
                _ => JObject::null(),
            };
            let streamed = request.body == HttpBody::Stream;
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_static_method_unchecked(
                    <&JClass<'_>>::from(j.net.as_obj()),
                    j.net_fetch,
                    ReturnType::Primitive(Primitive::Void),
                    &[
                        JValue::Long(key).as_jni(),
                        JValue::Object(&method).as_jni(),
                        JValue::Object(&url).as_jni(),
                        JValue::Object(&headers).as_jni(),
                        JValue::Object(&body).as_jni(),
                        JValue::Bool(streamed.into()).as_jni(),
                        JValue::Bool(request.follow_redirects.into()).as_jni(),
                    ],
                )
            }
            .map(|_| ())
        });
        Box::new(Task { key })
    }
}

/// `Net.nativeHead`: the response's status and headers.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Net_nativeHead(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    key: jlong,
    status: jint,
    url: JString<'_>,
    redirected: jboolean,
    headers: JObjectArray<'_>,
) {
    let head = (|| -> jni::errors::Result<HttpHead> {
        let url = String::from(env.get_string(&url)?);
        let count = env.get_array_length(&headers)?;
        let mut pairs = Vec::with_capacity(count as usize / 2);
        for i in (0..count - 1).step_by(2) {
            let k: JString<'_> = env.get_object_array_element(&headers, i)?.into();
            let v: JString<'_> = env.get_object_array_element(&headers, i + 1)?.into();
            pairs.push((
                String::from(env.get_string(&k)?),
                String::from(env.get_string(&v)?),
            ));
        }
        Ok(HttpHead {
            status: status as u16,
            status_text: String::new(),
            url,
            redirected: redirected != 0,
            headers: pairs,
        })
    })();
    report(
        key,
        match head {
            Ok(head) => FetchEvent::Head(head),
            Err(e) => FetchEvent::Failed(e.to_string()),
        },
    );
}

/// `Net.nativeData`: bytes of the response body.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Net_nativeData(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    key: jlong,
    data: JByteArray<'_>,
) {
    match env.convert_byte_array(&data) {
        Ok(bytes) => report(key, FetchEvent::Data(bytes)),
        Err(e) => report(key, FetchEvent::Failed(e.to_string())),
    }
}

/// `Net.nativeEnd`: the body is complete.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Net_nativeEnd(_: JNIEnv<'_>, _: JClass<'_>, key: jlong) {
    report(key, FetchEvent::End);
}

/// `Net.nativeFail`: the request failed.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Net_nativeFail(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    key: jlong,
    message: JString<'_>,
) {
    let message = env
        .get_string(&message)
        .map(String::from)
        .unwrap_or_default();
    report(key, FetchEvent::Failed(message));
}

/// `Net.nativeBodyWanted`: send the next chunk of the streamed body.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Net_nativeBodyWanted(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    key: jlong,
) {
    report(key, FetchEvent::BodyWanted);
}
