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

#include "maka_plugin_runtime.h"

static const uint8_t manifest[] =
    "{\"abiVersion\":1,\"packageId\":\"c-echo\",\"contributions\":[{\"id\":\"echo\",\"kind\":\"tool\",\"tool\":{\"name\":\"c_echo\",\"description\":\"C ABI echo tool\",\"parameters\":{\"type\":\"object\"}}}]}";
static const uint8_t result[] = "{\"from\":\"c\"}";
static uint8_t heap[64 * 1024];
static uint32_t next_heap;

uint32_t maka_plugin_manifest_ptr(void) { return (uint32_t)(uintptr_t)manifest; }
uint32_t maka_plugin_manifest_len(void) { return (uint32_t)(sizeof(manifest) - 1); }

uint32_t maka_plugin_alloc(uint32_t size) {
  uint32_t aligned = (size + 7u) & ~7u;
  if (aligned > sizeof(heap) - next_heap) return 0;
  uint32_t result_ptr = (uint32_t)(uintptr_t)heap + next_heap;
  next_heap += aligned;
  return result_ptr;
}

void maka_plugin_free(uint32_t ptr, uint32_t size) {
  (void)ptr;
  (void)size;
}

uint64_t maka_plugin_invoke(uint32_t input_ptr, uint32_t input_len) {
  (void)input_ptr;
  (void)input_len;
  return maka_plugin_pack((uint32_t)(uintptr_t)result, (uint32_t)(sizeof(result) - 1));
}
