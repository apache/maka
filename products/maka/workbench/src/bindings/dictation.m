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

#import <ApplicationServices/ApplicationServices.h>
#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <Security/Security.h>

typedef void (*Completion)(void *, const char *, const char *);

static NSDictionary *keyItem(void) {
    return @{
        (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService : @"org.apache.maka.dictation",
        (__bridge id)kSecAttrAccount : @"deepseek"
    };
}

static NSString *legacyKey(NSError **error) {
    NSMutableDictionary *query = keyItem().mutableCopy;
    query[(__bridge id)kSecReturnData] = @YES;
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status == errSecSuccess)
        return [[NSString alloc] initWithData:CFBridgingRelease(result) encoding:NSUTF8StringEncoding];
    if (status == errSecItemNotFound)
        return NSProcessInfo.processInfo.environment[@"DEEPSEEK_API_KEY"];
    *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
    return nil;
}

// The Core Audio UID is stable across reconnects. Device IDs are only valid for this boot.
void maka_input_devices(void *context, void (*append)(void *, const char *, const char *)) {
    AudioObjectPropertyAddress list = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                       kAudioObjectPropertyElementMain};
    UInt32 bytes = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &list, 0, NULL, &bytes) || !bytes)
        return;
    NSMutableData *storage = [NSMutableData dataWithLength:bytes];
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &list, 0, NULL, &bytes, storage.mutableBytes))
        return;
    const AudioDeviceID *devices = storage.bytes;
    for (NSUInteger i = 0; i < bytes / sizeof(AudioDeviceID); i++) {
        AudioObjectPropertyAddress inputs = {kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput,
                                             kAudioObjectPropertyElementMain};
        UInt32 streams = 0;
        if (AudioObjectGetPropertyDataSize(devices[i], &inputs, 0, NULL, &streams) || !streams)
            continue;
        AudioObjectPropertyAddress property = {kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal,
                                               kAudioObjectPropertyElementMain};
        CFStringRef value = NULL;
        UInt32 size = sizeof(value);
        if (AudioObjectGetPropertyData(devices[i], &property, 0, NULL, &size, &value))
            continue;
        NSString *uid = CFBridgingRelease(value);
        property.mSelector = kAudioObjectPropertyName;
        value = NULL;
        if (AudioObjectGetPropertyData(devices[i], &property, 0, NULL, &size, &value))
            continue;
        NSString *name = CFBridgingRelease(value);
        if (uid.length && name.length)
            append(context, uid.UTF8String, name.UTF8String);
    }
}

// The input callback and recording controls share the main run loop. Only this queue
// changes device. With no UID, Core Audio routes the queue to the system default.
@interface MakaMicRecording : NSObject {
    AudioQueueRef _queue;
    AudioFileID _file;
    SInt64 _frames;
    OSStatus _failure;
}
- (OSStatus)start:(NSURL *)url device:(NSString *)uid;
- (BOOL)finish;
- (double)level;
@end

@implementation MakaMicRecording
- (void)accept:(AudioQueueBufferRef)buffer {
    if (!_queue || _failure)
        return;
    UInt32 frames = MIN(buffer->mAudioDataByteSize / 2, 120 * 16000 - _frames);
    if (frames) {
        _failure =
            AudioFileWritePackets(_file, false, frames * 2, NULL, _frames, &frames, buffer->mAudioData);
        _frames += frames;
    }
    if (!_failure && _frames < 120 * 16000)
        _failure = AudioQueueEnqueueBuffer(_queue, buffer, 0, NULL);
    if (_failure || _frames >= 120 * 16000)
        dispatch_async(dispatch_get_main_queue(), ^{
            [self finish];
        });
}
static void inputBuffer(void *context, AudioQueueRef queue, AudioQueueBufferRef buffer,
                        const AudioTimeStamp *time, UInt32 count,
                        const AudioStreamPacketDescription *packets) {
    (void)queue;
    (void)time;
    (void)count;
    (void)packets;
    [(__bridge MakaMicRecording *)context accept:buffer];
}
- (OSStatus)start:(NSURL *)url device:(NSString *)uid {
    AudioStreamBasicDescription pcm = {.mSampleRate = 16000,
                                       .mFormatID = kAudioFormatLinearPCM,
                                       .mFormatFlags =
                                           kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                       .mBytesPerPacket = 2,
                                       .mFramesPerPacket = 1,
                                       .mBytesPerFrame = 2,
                                       .mChannelsPerFrame = 1,
                                       .mBitsPerChannel = 16};
    OSStatus err = AudioQueueNewInput(&pcm, inputBuffer, (__bridge void *)self, CFRunLoopGetMain(),
                                      kCFRunLoopCommonModes, 0, &_queue);
    if (!err && uid.length) {
        CFStringRef device = (__bridge CFStringRef)uid;
        err = AudioQueueSetProperty(_queue, kAudioQueueProperty_CurrentDevice, &device, sizeof(device));
    }
    if (!err)
        err = AudioFileCreateWithURL((__bridge CFURLRef)url, kAudioFileWAVEType, &pcm,
                                     kAudioFileFlags_EraseFile, &_file);
    UInt32 meter = 1;
    if (!err)
        err = AudioQueueSetProperty(_queue, kAudioQueueProperty_EnableLevelMetering, &meter, sizeof(meter));
    for (int i = 0; !err && i < 3; ++i) {
        AudioQueueBufferRef buffer;
        err = AudioQueueAllocateBuffer(_queue, 2048, &buffer);
        if (!err)
            err = AudioQueueEnqueueBuffer(_queue, buffer, 0, NULL);
    }
    if (!err)
        err = AudioQueueStart(_queue, NULL);
    if (err)
        [self finish];
    return err;
}
- (double)level {
    if (!_queue || _failure)
        return -1;
    AudioQueueLevelMeterState meter;
    UInt32 size = sizeof(meter);
    if (AudioQueueGetProperty(_queue, kAudioQueueProperty_CurrentLevelMeterDB, &meter, &size))
        return -1;
    return fmin(1, fmax(0, (meter.mAveragePower + 55) / 55));
}
- (BOOL)finish {
    if (_queue) {
        AudioQueueRef queue = _queue;
        _queue = NULL;
        AudioQueueDispose(queue, true);
    }
    if (_file) {
        OSStatus err = AudioFileClose(_file);
        if (!_failure)
            _failure = err;
        _file = NULL;
    }
    return !_failure && _frames > 0;
}
@end

static NSMutableDictionary<NSString *, MakaMicRecording *> *recorders;
static NSMutableSet<NSString *> *pending;

static void showRecorder(NSURL *file, NSString *key, NSString *device, void *context,
                         Completion done) {
    MakaMicRecording *recorder = [MakaMicRecording new];
    if ([recorder start:file device:device]) {
        done(context, NULL,
             device.length ? "dictation.error.selected_microphone_unavailable"
                           : "dictation.error.microphone_start_failed");
        return;
    }
    recorders[file.path] = recorder;
    done(context, key.UTF8String, NULL);
}

typedef void (*Sample)(void *, double);

void maka_record_sample(const char *path, void *context, Sample done) {
    NSString *identifier = [NSString stringWithUTF8String:path];
    dispatch_async(dispatch_get_main_queue(), ^{
        MakaMicRecording *recorder = recorders[identifier];
        double level = recorder ? [recorder level] : -1;
        done(context, level);
    });
}

void maka_record_stop(const char *path, void *context, Sample done) {
    NSString *identifier = [NSString stringWithUTF8String:path];
    dispatch_async(dispatch_get_main_queue(), ^{
        [pending removeObject:identifier];
        BOOL saved = [recorders[identifier] finish];
        [recorders removeObjectForKey:identifier];
        if (done)
            done(context, saved ? 0 : -1);
    });
}

static void recordSpeech(NSURL *file, NSWindow *window, NSString *key, NSString *device, void *context,
                         Completion done) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL allowed) {
                                 dispatch_async(dispatch_get_main_queue(), ^{
                                     if (![pending containsObject:file.path]) {
                                         done(context, NULL, NULL);
                                         return;
                                     }
                                     [pending removeObject:file.path];
                                     if (!allowed) {
                                         done(context, NULL, "dictation.error.microphone_permission_denied");
                                         return;
                                     }
                                     if (window && (!window.visible || window.attachedSheet)) {
                                         done(context, NULL, NULL);
                                         return;
                                     }
                                     showRecorder(file, key, device, context, done);
                                 });
                             }];
}

// A first click or an accessibility press can arrive before AppKit assigns a key window.
static NSWindow *dictationWindow(void) {
    for (NSWindow *window in NSApp.orderedWindows) {
        if (window.visible && window.canBecomeMainWindow && !window.sheetParent &&
            ![window isKindOfClass:NSPanel.class])
            return window;
    }
    return nil;
}

bool maka_has_dictation_key(void) {
    NSError *error = nil;
    return legacyKey(&error).length > 0;
}

void maka_record_message(const char *path, const char *uid, bool modelConnection, bool quickLauncher, void *context, Completion done) {
    NSString *device = [NSString stringWithUTF8String:uid];
    NSURL *file = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!recorders) {
            recorders = [NSMutableDictionary dictionary];
            pending = [NSMutableSet set];
        }
        if (recorders.count || pending.count) {
            done(context, NULL, "dictation.error.already_active");
            return;
        }
        // The launcher owns cancellation through its popup lifetime. It may still be
        // opening when the hotkey starts capture, and must leave the foreground app alone.
        NSWindow *window = quickLauncher ? nil : dictationWindow();
        if (!quickLauncher) {
            if (!window.visible || window.sheetParent || window.attachedSheet) {
                done(context, NULL, "dictation.error.chat_window_required");
                return;
            }
            [NSApp activateIgnoringOtherApps:YES];
            [window makeKeyAndOrderFront:nil];
        }
        if (![NSBundle.mainBundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"]) {
            done(context, NULL, "dictation.error.app_bundle_required");
            return;
        }
        NSError *lookupError = nil;
        NSString *stored = modelConnection ? @"model" : legacyKey(&lookupError);
        if (lookupError) {
            done(context, NULL, lookupError.localizedDescription.UTF8String);
            return;
        }
        if (stored.length) {
            [pending addObject:file.path];
            recordSpeech(file, window, stored, device, context, done);
            return;
        }
        done(context, NULL, "dictation.error.model_connection_required");
    });
}

int maka_microphone_status(void) {
    return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}

// Called from a blocking worker. Wait for the decision before refreshing the UI.
bool maka_request_microphone(void) {
    if (![NSBundle.mainBundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"])
        return false;
    if (maka_microphone_status() != AVAuthorizationStatusNotDetermined)
        return true;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allowed) {
        (void)allowed;
        dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    return true;
}

void maka_request_accessibility(void) {
    AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{
        (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES
    });
}
