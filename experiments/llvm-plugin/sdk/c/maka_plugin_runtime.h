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

#ifndef MAKA_PLUGIN_RUNTIME_V0_H
#define MAKA_PLUGIN_RUNTIME_V0_H

#include <stdint.h>

#define MAKA_PLUGIN_ABI_VERSION 1u

typedef struct maka_plugin_bytes {
  const uint8_t *ptr;
  uint32_t len;
} maka_plugin_bytes;

uint32_t maka_plugin_manifest_ptr(void);
uint32_t maka_plugin_manifest_len(void);
uint32_t maka_plugin_alloc(uint32_t size);
void maka_plugin_free(uint32_t ptr, uint32_t size);
uint64_t maka_plugin_invoke(uint32_t input_ptr, uint32_t input_len);

static inline uint64_t maka_plugin_pack(uint32_t ptr, uint32_t len) {
  return ((uint64_t)ptr << 32u) | (uint64_t)len;
}

#endif
