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

#import <UserNotifications/UserNotifications.h>

NS_ASSUME_NONNULL_BEGIN

static UNUserNotificationCenter * _Nullable notificationCenter(void) {
    // currentNotificationCenter raises an exception in an unbundled process.
    if (!NSBundle.mainBundle.bundleIdentifier) return nil;
    return UNUserNotificationCenter.currentNotificationCenter;
}

@interface MakaDesktopNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, copy) void (^opened)(NSString *tag);
@end

@implementation MakaDesktopNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))done {
    done(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList |
         UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))done {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
        self.opened(response.notification.request.identifier);
    }
    done();
}
@end

NSObject * _Nullable maka_install_notification_delegate(void (^opened)(NSString *)) NS_RETURNS_RETAINED {
    UNUserNotificationCenter *center = notificationCenter();
    if (!center) return nil;
    MakaDesktopNotificationDelegate *delegate = [MakaDesktopNotificationDelegate new];
    delegate.opened = opened;
    center.delegate = delegate;
    return delegate;
}

void maka_show_notification(NSString *tag, NSString *title, NSString *body,
                            void (^done)(NSString * _Nullable error)) {
    UNUserNotificationCenter *center = notificationCenter();
    if (!center) {
        done(@"desktop notifications require a macOS app bundle identifier");
        return;
    }
    void (^postIfAuthorized)(BOOL, NSError * _Nullable) = ^(BOOL granted, NSError * _Nullable error) {
        if (error || !granted) {
            done(error ? error.localizedDescription : @"notification permission was denied");
            return;
        }
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.title = title;
        content.body = body;
        content.sound = UNNotificationSound.defaultSound;
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:tag
                                                                              content:content
                                                                              trigger:nil];
        [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
            done(error.localizedDescription);
        }];
    };
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        UNAuthorizationStatus status = settings.authorizationStatus;
        if (status == UNAuthorizationStatusNotDetermined) {
            [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound
                                  completionHandler:postIfAuthorized];
        } else {
            BOOL granted = status == UNAuthorizationStatusAuthorized || status == UNAuthorizationStatusProvisional;
            postIfAuthorized(granted, nil);
        }
    }];
}

NS_ASSUME_NONNULL_END
