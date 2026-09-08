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

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>
#include <string>

struct Query {
  napi_async_work work;
  napi_deferred deferred;
  int32_t status = -1;
  std::string error;
};

static void Execute(napi_env, void* data) {
  auto* query = static_cast<Query*>(data);
  @autoreleasepool {
    @try {
      NSBundle* bundle = NSBundle.mainBundle;
      if (bundle.bundleIdentifier.length == 0 ||
          ![bundle.bundleURL.pathExtension isEqualToString:@"app"]) {
        query->error = "Notification settings require an application bundle";
        return;
      }
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      // The OS retains this block and its storage, even if our wait times out.
      __block UNNotificationSettings* settings = nil;
      [UNUserNotificationCenter.currentNotificationCenter
          getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* value) {
            settings = value;
            dispatch_semaphore_signal(done);
          }];
      if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)) != 0) {
        query->error = "Notification settings query timed out";
        return;
      }
      if (settings == nil) {
        query->error = "Notification settings query returned no settings";
        return;
      }
      query->status = static_cast<int32_t>(settings.authorizationStatus);
    } @catch (NSException* exception) {
      query->error = exception.reason.UTF8String ?: "Notification settings query failed";
    }
  }
}

static void Complete(napi_env env, napi_status status, void* data) {
  auto* query = static_cast<Query*>(data);
  if (status != napi_ok && query->error.empty()) {
    query->error = "Notification settings query cancelled";
  }
  napi_value value;
  if (query->error.empty()) {
    napi_create_int32(env, query->status, &value);
    napi_resolve_deferred(env, query->deferred, value);
  } else {
    napi_value message;
    napi_create_string_utf8(env, query->error.c_str(), NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &value);
    napi_reject_deferred(env, query->deferred, value);
  }
  napi_delete_async_work(env, query->work);
  delete query;
}

static napi_value GetAuthorizationStatus(napi_env env, napi_callback_info) {
  auto* query = new Query{};
  napi_value promise;
  napi_value name;
  if (napi_create_promise(env, &query->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "notification-settings", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, nullptr, name, Execute, Complete, query, &query->work) != napi_ok ||
      napi_queue_async_work(env, query->work) != napi_ok) {
    if (query->work) napi_delete_async_work(env, query->work);
    delete query;
    napi_throw_error(env, nullptr, "Could not schedule notification settings query");
    return nullptr;
  }
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "getAuthorizationStatus", NAPI_AUTO_LENGTH,
                       GetAuthorizationStatus, nullptr, &function);
  napi_set_named_property(env, exports, "getAuthorizationStatus", function);
  return exports;
}

NAPI_MODULE(notification_settings, Init)
