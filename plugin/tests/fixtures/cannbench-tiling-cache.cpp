#include <array>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "canness_tiling_host.h"

#define __gm__
using aclrtStream = void*;
constexpr int ACL_SUCCESS = 0;
constexpr int ACL_MEMCPY_HOST_TO_DEVICE = 1;

std::mutex runtimeMutex;
std::condition_variable progress;
std::vector<std::pair<uint8_t*, double>> pending;
std::array<uint8_t, 256> device{};
int syncCalls = 0;
int copyCalls = 0;
int reads = 0;
bool failSync = false;
bool failCopy = false;
bool pauseFirstEnqueue = false;
bool firstEnqueueStarted = false;
bool releaseFirstEnqueue = false;

int aclrtSynchronizeDevice() {
    std::lock_guard<std::mutex> lock(runtimeMutex);
    ++syncCalls;
    progress.notify_all();
    if (failSync) return 17;
    for (const auto& [source, expected] : pending) {
        double actual;
        const auto offset = cannessAttrOffset(0) + sizeof(CannessAttrTable) + offsetof(CannessDeviceAttr, numberBits);
        std::memcpy(&actual, source + offset, sizeof(actual));
        assert(actual == expected);
        ++reads;
    }
    pending.clear();
    return ACL_SUCCESS;
}

int aclrtMemcpy(void* target, uint64_t capacity, const void* source, size_t size, int kind) {
    std::lock_guard<std::mutex> lock(runtimeMutex);
    assert(size <= capacity && kind == ACL_MEMCPY_HOST_TO_DEVICE);
    ++copyCalls;
    if (failCopy) {
        // A failed transfer can leave the previous image unusable too.
        std::memset(target, 0, size);
        return 19;
    }
    std::memcpy(target, source, size);
    progress.notify_all();
    return ACL_SUCCESS;
}

extern "C" void canness_kernel(uint8_t* expected, uint8_t*, uint8_t* tiling) {
    double value;
    std::memcpy(&value, expected, sizeof(value));
    std::unique_lock<std::mutex> lock(runtimeMutex);
    if (pauseFirstEnqueue && value == 1) {
        firstEnqueueStarted = true;
        progress.notify_all();
        progress.wait(lock, [] { return releaseFirstEnqueue; });
    }
    pending.emplace_back(tiling, value);
}

#include "launch-under-test.cpp"

int launch(double mode) {
    return canness_launch(&mode, nullptr, 16, nullptr, device.data(), device.size(), mode);
}

int main(int argc, char** argv) {
    assert(argc == 2);
    const std::string scenario(argv[1]);
    if (scenario == "sync-failure") {
        failSync = true;
        assert(launch(1) == 17 && copyCalls == 0);
        failSync = false;
        assert(launch(1) == ACL_SUCCESS && syncCalls == 2 && copyCalls == 1);
    } else if (scenario == "copy-failure") {
        failCopy = true;
        assert(launch(1) == 19 && copyCalls == 1);
        failCopy = false;
        assert(launch(1) == ACL_SUCCESS && copyCalls == 2);
    } else if (scenario == "partial-copy") {
        assert(launch(1) == ACL_SUCCESS);
        failCopy = true;
        assert(launch(2) == 19 && reads == 1);
        failCopy = false;
        assert(launch(1) == ACL_SUCCESS && copyCalls == 3);
    } else {
        assert(scenario == "concurrent-uploads");
        pauseFirstEnqueue = true;
        std::thread first([] { assert(launch(1) == ACL_SUCCESS); });
        std::unique_lock<std::mutex> lock(runtimeMutex);
        progress.wait(lock, [] { return firstEnqueueStarted; });
        std::thread second([] { assert(launch(2) == ACL_SUCCESS); });
        // Let the second caller try to overwrite the block before the first
        // caller can enqueue. A correct launcher keeps it outside the runtime.
        const bool interleaved = progress.wait_for(lock, std::chrono::milliseconds(250), [] { return copyCalls > 1; });
        releaseFirstEnqueue = true;
        lock.unlock();
        progress.notify_all();
        first.join();
        second.join();
        assert(!interleaved && reads == 1 && copyCalls == 2);
        assert(aclrtSynchronizeDevice() == ACL_SUCCESS && reads == 2);
        return 0;
    }
    const int copied = copyCalls;
    assert(launch(1) == ACL_SUCCESS && copyCalls == copied);
    assert(aclrtSynchronizeDevice() == ACL_SUCCESS && reads >= 2);
}
