; Licensed to the Apache Software Foundation (ASF) under one
; or more contributor license agreements.  See the NOTICE file
; distributed with this work for additional information
; regarding copyright ownership.  The ASF licenses this file
; to you under the Apache License, Version 2.0 (the
; "License"); you may not use this file except in compliance
; with the License.  You may obtain a copy of the License at
;
;     http://www.apache.org/licenses/LICENSE-2.0
;
; Unless required by applicable law or agreed to in writing,
; software distributed under the License is distributed on an
; "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
; KIND, either express or implied.  See the License for the
; specific language governing permissions and limitations
; under the License.

; Minimal LLVM IR fixture for maka:plugin/runtime@1.
; The strings are intentionally static so this file is easy to inspect in an
; IR review. A production plugin should allocate the result per invocation.
target triple = "wasm32-unknown-unknown"

@manifest = private constant [175 x i8] c"{\22abiVersion\22:1,\22packageId\22:\22llvm-echo\22,\22contributions\22:[{\22id\22:\22echo\22,\22kind\22:\22tool\22,\22tool\22:{\22name\22:\22llvm_echo\22,\22description\22:\22LLVM IR tool\22,\22parameters\22:{\22type\22:\22object\22}}}]}\00"
@result = private constant [16 x i8] c"{\22from\22:\22llvm\22}\00"

define i32 @maka_plugin_manifest_ptr() {
entry:
  ret i32 ptrtoint (ptr @manifest to i32)
}

define i32 @maka_plugin_manifest_len() {
entry:
  ret i32 174
}

define i32 @maka_plugin_alloc(i32 %size) {
entry:
  ret i32 4096
}

define void @maka_plugin_free(i32 %ptr, i32 %size) {
entry:
  ret void
}

define i64 @maka_plugin_invoke(i32 %input_ptr, i32 %input_len) {
entry:
  %ptr = ptrtoint ptr @result to i64
  %shifted = shl i64 %ptr, 32
  %packed = or i64 %shifted, 15
  ret i64 %packed
}
