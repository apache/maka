package com.longbridge.nsh;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * Java interfaces implemented in Rust ({@code nsh::proxy} of the {@code nsh-platform-android} crate): a
 * {@link Proxy} whose calls reach the Rust handler {@code handle} names, so Rust code (an nshm) can hand Java a
 * listener or a callback ({@code Runnable}, a framework's {@code ...Listener}) without shipping a Java class. The
 * handler answers on the thread Java calls it on; once Rust drops it, calls answer {@code null}.
 */
final class NativeProxy implements InvocationHandler {
    private final long handle;

    private NativeProxy(long handle) {
        this.handle = handle;
    }

    /**
     * An object implementing the interfaces named {@code interfaces} (binary names, {@code
     * android.speech.RecognitionListener}) whose calls reach handler {@code handle}. Any thread.
     */
    static Object create(String[] interfaces, long handle) throws ClassNotFoundException {
        ClassLoader loader = NativeProxy.class.getClassLoader();
        Class<?>[] classes = new Class<?>[interfaces.length];
        for (int i = 0; i < interfaces.length; i++) {
            classes[i] = Class.forName(interfaces[i], false, loader);
        }
        return Proxy.newProxyInstance(loader, classes, new NativeProxy(handle));
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) {
        // `Object`'s own methods are the proxy's: a collection or the framework may call them.
        if (method.getDeclaringClass() == Object.class) {
            switch (method.getName()) {
                case "equals":
                    return proxy == args[0];
                case "hashCode":
                    return System.identityHashCode(proxy);
                default:
                    return "NativeProxy@" + Integer.toHexString(System.identityHashCode(proxy));
            }
        }
        return call(handle, method.getName(), args);
    }

    /** Handler {@code handle}'s answer to {@code method} with {@code args} ({@code null}: none). */
    private static native Object call(long handle, String method, Object[] args);
}
