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

#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
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

// Accessed only on the main thread. A path identifies one draft's native recording.
static NSMutableDictionary<NSString *, AVAudioRecorder *> *recorders;
static NSMutableSet<NSString *> *pending;

static void showRecorder(NSURL *file, NSString *key, bool zh, void *context, Completion done) {
    NSError *error = nil;
    NSDictionary *settings = @{
        AVFormatIDKey : @(kAudioFormatLinearPCM),
        AVSampleRateKey : @16000,
        AVNumberOfChannelsKey : @1,
        AVLinearPCMBitDepthKey : @16,
        AVLinearPCMIsFloatKey : @NO,
        AVLinearPCMIsBigEndianKey : @NO
    };
    AVAudioRecorder *recorder = [[AVAudioRecorder alloc] initWithURL:file settings:settings error:&error];
    recorder.meteringEnabled = YES;
    if (![recorder recordForDuration:120]) {
        done(context, NULL,
             error.localizedDescription.UTF8String
                 ?: (zh ? "无法启动麦克风。" : "Could not start the microphone."));
        return;
    }
    recorders[file.path] = recorder;
    done(context, key.UTF8String, NULL);
}

typedef void (*Sample)(void *, double);

void maka_record_sample(const char *path, void *context, Sample done) {
    NSString *identifier = [NSString stringWithUTF8String:path];
    dispatch_async(dispatch_get_main_queue(), ^{
        AVAudioRecorder *recorder = recorders[identifier];
        double level = -1;
        if (recorder.recording) {
            [recorder updateMeters];
            level = fmin(1, fmax(0, ([recorder averagePowerForChannel:0] + 55) / 55));
        }
        done(context, level);
    });
}

void maka_record_stop(const char *path, void *context, Sample done) {
    NSString *identifier = [NSString stringWithUTF8String:path];
    dispatch_async(dispatch_get_main_queue(), ^{
        [pending removeObject:identifier];
        [recorders[identifier] stop];
        [recorders removeObjectForKey:identifier];
        if (done)
            done(context, 0);
    });
}

static void recordSpeech(NSURL *file, NSWindow *window, NSString *key, bool zh, void *context,
                         Completion done) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL allowed) {
                                 dispatch_async(dispatch_get_main_queue(), ^{
                                     if (![pending containsObject:file.path]) {
                                         done(context, NULL, NULL);
                                         return;
                                     }
                                     if (!allowed) {
                                         done(context, NULL,
                                              zh ? "请在系统设置中允许 Maka 使用麦克风。"
                                                 : "Allow microphone access for Maka in System Settings.");
                                         return;
                                     }
                                     if (window && (!window.visible || window.attachedSheet)) {
                                         done(context, NULL, NULL);
                                         return;
                                     }
                                     showRecorder(file, key, zh, context, done);
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

void maka_record_message(const char *path, bool zh, bool modelConnection, bool quickLauncher, void *context, Completion done) {
    NSURL *file = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!recorders) {
            recorders = [NSMutableDictionary dictionary];
            pending = [NSMutableSet set];
        }
        if (recorders.count || pending.count) {
            done(context, NULL, zh ? "已有听写正在进行。" : "Dictation is already active.");
            return;
        }
        [pending addObject:file.path];
        // The launcher owns cancellation through its popup lifetime. It may still be
        // opening when the hotkey starts capture, and must leave the foreground app alone.
        NSWindow *window = quickLauncher ? nil : dictationWindow();
        if (!quickLauncher) {
            if (!window.visible || window.sheetParent || window.attachedSheet) {
                done(context, NULL, zh ? "请先打开聊天窗口。" : "Open the chat window first.");
                return;
            }
            [NSApp activateIgnoringOtherApps:YES];
            [window makeKeyAndOrderFront:nil];
        }
        if (![NSBundle.mainBundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"]) {
            done(context, NULL, zh ? "请从 Maka.app 打开听写。" : "Open Maka.app to use dictation.");
            return;
        }
        NSError *lookupError = nil;
        NSString *stored = modelConnection ? @"model" : legacyKey(&lookupError);
        if (lookupError) {
            done(context, NULL, lookupError.localizedDescription.UTF8String);
            return;
        }
        if (stored.length) {
            recordSpeech(file, window, stored, zh, context, done);
            return;
        }
        done(context, NULL, zh ? "请先在设置中选择 DeepSeek 模型连接。" : "Choose a DeepSeek model connection in Settings first.");
    });
}
