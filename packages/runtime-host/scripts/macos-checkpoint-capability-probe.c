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

/* Developer-only creation/deletion probe. Not a workspace authority.
 * The companion runner supplies only its newly created disposable APFS volume.
 * This executable does not request privilege, change signatures, mount a
 * snapshot, or claim that successful creation proves end-to-end feasibility.
 */
#include <Security/SecTask.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/snapshot.h>
#include <unistd.h>
#include <uuid/uuid.h>

static void print_entitlement(SecTaskRef task, const char *name) {
    CFStringRef key = CFStringCreateWithCString(NULL, name, kCFStringEncodingUTF8);
    CFErrorRef error = NULL;
    CFTypeRef value = task ? SecTaskCopyValueForEntitlement(task, key, &error) : NULL;
    const char *state = "null";
    if (value && CFGetTypeID(value) == CFBooleanGetTypeID()) {
        state = CFBooleanGetValue((CFBooleanRef)value) ? "true" : "false";
    } else if (!value && !error && task) {
        state = "false";
    }
    printf("\"%s\":{\"value\":%s,\"queryError\":%ld}", name, state,
           error ? (long)CFErrorGetCode(error) : (task ? 0L : -1L));
    if (value) CFRelease(value);
    if (error) CFRelease(error);
    CFRelease(key);
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "Use the companion macos-checkpoint-capability-probe.mjs runner.\n");
        return 1;
    }
    char root[PATH_MAX];
    if (!realpath(argv[1], root)) return 1;
    /* Refuse normal workspace/boot-volume paths even when invoked directly. */
    char *component = strrchr(root, '/');
    if (!component || strcmp(component, "/live") != 0) return 1;
    *component = '\0';
    const char *parent = strrchr(root, '/');
    const char prefix[] = "maka-checkpoint-capability-";
    if (!parent || strncmp(parent + 1, prefix, sizeof(prefix) - 1) != 0) return 1;
    *component = '/';

    int fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0) return 1;
    struct statfs fs;
    if (fstatfs(fd, &fs) != 0 || strcmp(fs.f_fstypename, "apfs") != 0 ||
        strcmp(fs.f_mntonname, root) != 0 || (fs.f_flags & MNT_ROOTFS)) {
        close(fd);
        return 1;
    }
    struct attrlist attrs = {0};
    attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
    attrs.volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES;
    struct {
        uint32_t length;
        vol_capabilities_attr_t capabilities;
    } result = {0};
    if (fgetattrlist(fd, &attrs, &result, sizeof(result), 0) != 0) {
        perror("fgetattrlist");
        close(fd);
        return 1;
    }
    int supported =
        (result.capabilities.valid[VOL_CAPABILITIES_INTERFACES] & VOL_CAP_INT_SNAPSHOT) &&
        (result.capabilities.capabilities[VOL_CAPABILITIES_INTERFACES] & VOL_CAP_INT_SNAPSHOT);

    printf("{\"uid\":%u,\"euid\":%u,\"filesystem\":\"apfs\",\"snapshotCapable\":%s,\"entitlements\":{",
           getuid(), geteuid(), supported ? "true" : "false");
    SecTaskRef task = SecTaskCreateFromSelf(NULL);
    print_entitlement(task, "com.apple.developer.vfs.snapshot");
    printf(",");
    print_entitlement(task, "com.apple.private.vfs.snapshot");
    printf(",");
    print_entitlement(task, "com.apple.private.apfs.arv.limited.snapshot");
    if (task) CFRelease(task);
    printf("},");

    uuid_t id;
    char uuid[37], name[80];
    uuid_generate_random(id);
    uuid_unparse_lower(id, uuid);
    snprintf(name, sizeof(name), "maka-checkpoint-probe-%s", uuid);
    int created = supported ? fs_snapshot_create(fd, name, 0) : -1;
    int create_error = supported ? (created == 0 ? 0 : errno) : ENOTSUP;
    /* Never delete a name whose creation failed, including EEXIST. */
    int deleted = created == 0 ? fs_snapshot_delete(fd, name, 0) : -1;
    int delete_error = created == 0 ? (deleted == 0 ? 0 : errno) : 0;
    printf("\"snapshotName\":\"%s\",\"createAttempted\":%s,\"created\":%s,\"createErrno\":%d,"
           "\"deleteAttempted\":%s,\"deleted\":%s,\"deleteErrno\":%d}\n",
           name, supported ? "true" : "false", created == 0 ? "true" : "false", create_error,
           created == 0 ? "true" : "false", deleted == 0 ? "true" : "false", delete_error);
    close(fd);
    if (created == 0) return deleted == 0 ? 0 : 1;
    return create_error == EPERM || create_error == EACCES || create_error == ENOTSUP ? 2 : 1;
}
