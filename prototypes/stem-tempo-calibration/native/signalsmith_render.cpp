#include <signalsmith-stretch.h>

extern "C" {
#include <sha256.h>
}

#include <algorithm>
#include <array>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(_WIN32)
#define NOMINMAX
#include <fcntl.h>
#include <io.h>
#include <share.h>
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#if defined(__APPLE__)
#include <sys/stdio.h>
#elif defined(__linux__)
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

#if defined(__unix__) || defined(__APPLE__)
#include <sys/resource.h>
#endif

namespace fs = std::filesystem;

namespace {

constexpr std::int64_t kOutputBlockFrames = 4096;
constexpr int kMaxChannelsPerStem = 8;
constexpr int kMaxLinkedChannels = 64;
constexpr double kMinPlaybackRate = 0.25;
constexpr double kMaxPlaybackRate = 4.0;
constexpr const char* kLeaseFileName = ".opusloops-render-lease";
constexpr std::uintmax_t kMaxRendererInputBytes = 1024U * 1024U;

static_assert(signalsmith::stretch::SignalsmithStretch<float>::version[0] == 1 &&
                  signalsmith::stretch::SignalsmithStretch<float>::version[1] == 3 &&
                  signalsmith::stretch::SignalsmithStretch<float>::version[2] == 2,
              "update renderer provenance when the vendored Signalsmith version changes");
static_assert(sizeof(float) == 4, "the renderer WAV contract requires 32-bit float samples");

class Error : public std::runtime_error {
  public:
    using std::runtime_error::runtime_error;
};

bool validSha256(const std::string& value) {
    return value.size() == 64 &&
           std::all_of(value.begin(), value.end(), [](unsigned char character) {
               return std::isdigit(character) != 0 ||
                      (character >= static_cast<unsigned char>('a') &&
                       character <= static_cast<unsigned char>('f'));
           });
}

std::string digestHex(const std::array<unsigned char, SHA256_DIGEST_SIZE>& digest) {
    std::ostringstream result;
    result << std::hex << std::setfill('0');
    for (const auto byte : digest)
        result << std::setw(2) << static_cast<unsigned int>(byte);
    return result.str();
}

std::string sha256Bytes(const std::string& content) {
    sha256_t context{};
    std::array<unsigned char, SHA256_DIGEST_SIZE> digest{};
    sha256_init(&context);
    sha256_update(&context, reinterpret_cast<const unsigned char*>(content.data()),
                  content.size());
    sha256_final(&context, digest.data());
    return digestHex(digest);
}

struct RegularFileState {
    std::uintmax_t bytes = 0;
    fs::file_time_type modifiedAt{};
};

RegularFileState regularFileState(const fs::path& path, const std::string& label) {
    std::error_code error;
    const auto status = fs::symlink_status(path, error);
    if (error)
        throw Error("cannot inspect " + label + ": " + path.string() + ": " + error.message());
    if (status.type() != fs::file_type::regular)
        throw Error(label + " must be a non-symlink regular file: " + path.string());
    const auto bytes = fs::file_size(path, error);
    if (error)
        throw Error("cannot size " + label + ": " + path.string() + ": " + error.message());
    const auto modifiedAt = fs::last_write_time(path, error);
    if (error)
        throw Error("cannot timestamp " + label + ": " + path.string() + ": " +
                    error.message());
    return {bytes, modifiedAt};
}

void ensureFileUnchanged(const fs::path& path, const std::string& label,
                         const RegularFileState& before, std::uintmax_t bytesRead) {
    const auto after = regularFileState(path, label);
    if (before.bytes != after.bytes || before.modifiedAt != after.modifiedAt ||
        bytesRead != before.bytes)
        throw Error(label + " changed while it was being read: " + path.string());
}

std::string readBoundRegularFile(const fs::path& path, const std::string& label,
                                 std::uintmax_t maximumBytes) {
    const auto before = regularFileState(path, label);
    if (before.bytes > maximumBytes ||
        before.bytes > static_cast<std::uintmax_t>(std::numeric_limits<std::streamsize>::max()))
        throw Error(label + " exceeds its byte limit: " + path.string());
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw Error("cannot open " + label + ": " + path.string());
    std::string content(static_cast<std::size_t>(before.bytes), '\0');
    if (!content.empty() &&
        !input.read(content.data(), static_cast<std::streamsize>(content.size())))
        throw Error("short read from " + label + ": " + path.string());
    ensureFileUnchanged(path, label, before, content.size());
    return content;
}

std::string systemErrorMessage(const std::string& action, const fs::path& path, int code) {
    return action + ": " + path.string() + ": " +
           std::error_code(code, std::generic_category()).message();
}

struct BoundFileIdentity {
    std::uint64_t device = 0;
    std::uint64_t inode = 0;
    std::uint64_t mode = 0;
    std::uint64_t bytes = 0;
    std::int64_t modifiedSeconds = 0;
    std::int64_t modifiedNanoseconds = 0;
    std::int64_t changedSeconds = 0;
    std::int64_t changedNanoseconds = 0;
};

bool operator==(const BoundFileIdentity& left, const BoundFileIdentity& right) {
    return left.device == right.device && left.inode == right.inode &&
           left.mode == right.mode && left.bytes == right.bytes &&
           left.modifiedSeconds == right.modifiedSeconds &&
           left.modifiedNanoseconds == right.modifiedNanoseconds &&
           left.changedSeconds == right.changedSeconds &&
           left.changedNanoseconds == right.changedNanoseconds;
}

#if defined(_WIN32)
std::uint64_t fileTimeValue(const FILETIME& value) {
    return (static_cast<std::uint64_t>(value.dwHighDateTime) << 32U) |
           static_cast<std::uint64_t>(value.dwLowDateTime);
}

BoundFileIdentity identityForHandle(HANDLE handle, const fs::path& path,
                                    const std::string& label) {
    BY_HANDLE_FILE_INFORMATION information{};
    if (!GetFileInformationByHandle(handle, &information)) {
        const auto code = static_cast<int>(GetLastError());
        throw Error("cannot inspect " + label + ": " + path.string() + ": " +
                    std::error_code(code, std::system_category()).message());
    }
    if ((information.dwFileAttributes &
         (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        throw Error(label + " must be a non-symlink regular file: " + path.string());
    const auto inode = (static_cast<std::uint64_t>(information.nFileIndexHigh) << 32U) |
                       static_cast<std::uint64_t>(information.nFileIndexLow);
    const auto bytes = (static_cast<std::uint64_t>(information.nFileSizeHigh) << 32U) |
                       static_cast<std::uint64_t>(information.nFileSizeLow);
    return {
        static_cast<std::uint64_t>(information.dwVolumeSerialNumber),
        inode,
        static_cast<std::uint64_t>(information.dwFileAttributes),
        bytes,
        static_cast<std::int64_t>(fileTimeValue(information.ftLastWriteTime)),
        0,
        static_cast<std::int64_t>(fileTimeValue(information.ftCreationTime)),
        0,
    };
}

HANDLE openWindowsBoundFile(const fs::path& path, const std::string& label) {
    const auto attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        const auto code = static_cast<int>(GetLastError());
        throw Error("cannot inspect " + label + ": " + path.string() + ": " +
                    std::error_code(code, std::system_category()).message());
    }
    if ((attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        throw Error(label + " must be a non-symlink regular file: " + path.string());
    const auto handle =
        CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        const auto code = static_cast<int>(GetLastError());
        throw Error("cannot open " + label + ": " + path.string() + ": " +
                    std::error_code(code, std::system_category()).message());
    }
    return handle;
}
#else
BoundFileIdentity identityForStat(const struct stat& information) {
#if defined(__APPLE__)
    const auto modifiedSeconds = information.st_mtimespec.tv_sec;
    const auto modifiedNanoseconds = information.st_mtimespec.tv_nsec;
    const auto changedSeconds = information.st_ctimespec.tv_sec;
    const auto changedNanoseconds = information.st_ctimespec.tv_nsec;
#else
    const auto modifiedSeconds = information.st_mtim.tv_sec;
    const auto modifiedNanoseconds = information.st_mtim.tv_nsec;
    const auto changedSeconds = information.st_ctim.tv_sec;
    const auto changedNanoseconds = information.st_ctim.tv_nsec;
#endif
    if (information.st_size < 0)
        throw Error("bound regular file reported a negative byte length");
    return {
        static_cast<std::uint64_t>(information.st_dev),
        static_cast<std::uint64_t>(information.st_ino),
        static_cast<std::uint64_t>(information.st_mode),
        static_cast<std::uint64_t>(information.st_size),
        static_cast<std::int64_t>(modifiedSeconds),
        static_cast<std::int64_t>(modifiedNanoseconds),
        static_cast<std::int64_t>(changedSeconds),
        static_cast<std::int64_t>(changedNanoseconds),
    };
}
#endif

class BoundRegularFile {
  public:
    BoundRegularFile(fs::path path, std::string label)
        : path_(std::move(path)), label_(std::move(label)) {
#if defined(_WIN32)
        handle_ = openWindowsBoundFile(path_, label_);
        try {
            identity_ = identityForHandle(handle_, path_, label_);
            verify();
        } catch (...) {
            CloseHandle(std::exchange(handle_, INVALID_HANDLE_VALUE));
            throw;
        }
#else
#ifndef O_NOFOLLOW
        throw Error("secure descriptor-bound WAV input is unsupported on this platform");
#else
        struct stat before{};
        if (::lstat(path_.c_str(), &before) != 0)
            throw Error(systemErrorMessage("cannot inspect " + label_, path_, errno));
        if (!S_ISREG(before.st_mode))
            throw Error(label_ + " must be a non-symlink regular file: " + path_.string());
        int flags = O_RDONLY | O_NOFOLLOW;
#ifdef O_CLOEXEC
        flags |= O_CLOEXEC;
#endif
#ifdef O_NONBLOCK
        flags |= O_NONBLOCK;
#endif
        do {
            descriptor_ = ::open(path_.c_str(), flags);
        } while (descriptor_ < 0 && errno == EINTR);
        if (descriptor_ < 0)
            throw Error(systemErrorMessage("cannot open " + label_, path_, errno));
        try {
#ifndef O_CLOEXEC
            if (::fcntl(descriptor_, F_SETFD, FD_CLOEXEC) != 0)
                throw Error(systemErrorMessage("cannot secure " + label_, path_, errno));
#endif
            struct stat opened{};
            if (::fstat(descriptor_, &opened) != 0)
                throw Error(systemErrorMessage("cannot inspect open " + label_, path_, errno));
            if (!S_ISREG(opened.st_mode))
                throw Error(label_ + " must be a non-symlink regular file: " + path_.string());
            identity_ = identityForStat(opened);
            if (!(identityForStat(before) == identity_))
                throw Error(label_ + " changed while it was being opened: " + path_.string());
            verify();
        } catch (...) {
            static_cast<void>(::close(std::exchange(descriptor_, -1)));
            throw;
        }
#endif
#endif
        if (identity_.bytes >
            static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
#if defined(_WIN32)
            static_cast<void>(CloseHandle(std::exchange(handle_, INVALID_HANDLE_VALUE)));
#else
            static_cast<void>(::close(std::exchange(descriptor_, -1)));
#endif
            throw Error(label_ + " is too large for descriptor-bound reads: " + path_.string());
        }
    }

    BoundRegularFile(const BoundRegularFile&) = delete;
    BoundRegularFile& operator=(const BoundRegularFile&) = delete;

    ~BoundRegularFile() {
#if defined(_WIN32)
        if (handle_ != INVALID_HANDLE_VALUE)
            static_cast<void>(CloseHandle(handle_));
#else
        if (descriptor_ >= 0)
            static_cast<void>(::close(descriptor_));
#endif
    }

    std::uint64_t size() const { return identity_.bytes; }
    std::uint64_t tell() const { return cursor_; }

    void seek(std::uint64_t offset) {
        if (offset > identity_.bytes)
            throw Error("WAV seek exceeds bound input: " + path_.string());
        cursor_ = offset;
    }

    void readExact(void* destination, std::size_t bytes) {
        if (bytes > identity_.bytes - cursor_)
            throw Error("unexpected end of WAV file: " + path_.string());
        readAt(cursor_, destination, bytes);
        cursor_ += static_cast<std::uint64_t>(bytes);
    }

    std::string sha256AndVerify() {
        verify();
        sha256_t context{};
        sha256_init(&context);
        std::array<unsigned char, 1024 * 1024> buffer{};
        std::uint64_t offset = 0;
        while (offset < identity_.bytes) {
            const auto count = static_cast<std::size_t>(std::min<std::uint64_t>(
                buffer.size(), identity_.bytes - offset));
            readAt(offset, buffer.data(), count);
            sha256_update(&context, buffer.data(), count);
            offset += static_cast<std::uint64_t>(count);
        }
        verify();
        std::array<unsigned char, SHA256_DIGEST_SIZE> digest{};
        sha256_final(&context, digest.data());
        return digestHex(digest);
    }

    void verify() const {
#if defined(_WIN32)
        if (!(identityForHandle(handle_, path_, label_) == identity_))
            throw Error(label_ + " descriptor identity changed: " + path_.string());
        const auto pathHandle = openWindowsBoundFile(path_, label_);
        try {
            if (!(identityForHandle(pathHandle, path_, label_) == identity_))
                throw Error(label_ + " path identity changed: " + path_.string());
        } catch (...) {
            CloseHandle(pathHandle);
            throw;
        }
        CloseHandle(pathHandle);
#else
        struct stat opened{};
        if (::fstat(descriptor_, &opened) != 0)
            throw Error(systemErrorMessage("cannot inspect open " + label_, path_, errno));
        if (!(identityForStat(opened) == identity_))
            throw Error(label_ + " descriptor identity changed: " + path_.string());
        struct stat currentPath{};
        if (::lstat(path_.c_str(), &currentPath) != 0)
            throw Error(systemErrorMessage("cannot inspect " + label_, path_, errno));
        if (!S_ISREG(currentPath.st_mode) || !(identityForStat(currentPath) == identity_))
            throw Error(label_ + " path identity changed: " + path_.string());
#endif
    }

  private:
    void readAt(std::uint64_t offset, void* destination, std::size_t bytes) {
        auto* cursor = static_cast<unsigned char*>(destination);
        std::size_t remaining = bytes;
        while (remaining > 0) {
#if defined(_WIN32)
            LARGE_INTEGER position{};
            position.QuadPart = static_cast<LONGLONG>(offset);
            if (!SetFilePointerEx(handle_, position, nullptr, FILE_BEGIN)) {
                const auto code = static_cast<int>(GetLastError());
                throw Error("cannot seek " + label_ + ": " + path_.string() + ": " +
                            std::error_code(code, std::system_category()).message());
            }
            const auto request = static_cast<DWORD>(std::min<std::size_t>(
                remaining, static_cast<std::size_t>(std::numeric_limits<DWORD>::max())));
            DWORD received = 0;
            if (!ReadFile(handle_, cursor, request, &received, nullptr)) {
                const auto code = static_cast<int>(GetLastError());
                throw Error("cannot read " + label_ + ": " + path_.string() + ": " +
                            std::error_code(code, std::system_category()).message());
            }
            const auto count = static_cast<std::size_t>(received);
#else
            const auto request = std::min<std::size_t>(
                remaining, static_cast<std::size_t>(std::numeric_limits<ssize_t>::max()));
            ssize_t received = -1;
            do {
                received = ::pread(descriptor_, cursor, request, static_cast<off_t>(offset));
            } while (received < 0 && errno == EINTR);
            if (received < 0)
                throw Error(systemErrorMessage("cannot read " + label_, path_, errno));
            const auto count = static_cast<std::size_t>(received);
#endif
            if (count == 0)
                throw Error("short read from " + label_ + ": " + path_.string());
            cursor += count;
            remaining -= count;
            offset += static_cast<std::uint64_t>(count);
        }
    }

    fs::path path_;
    std::string label_;
    BoundFileIdentity identity_{};
    std::uint64_t cursor_ = 0;
#if defined(_WIN32)
    HANDLE handle_ = INVALID_HANDLE_VALUE;
#else
    int descriptor_ = -1;
#endif
};

class ExclusiveFile {
  public:
    explicit ExclusiveFile(const fs::path& path) : path_(path) {
#if defined(_WIN32)
        const auto status = _wsopen_s(&descriptor_, path.c_str(),
                                      _O_WRONLY | _O_CREAT | _O_EXCL | _O_BINARY,
                                      _SH_DENYRW, _S_IREAD | _S_IWRITE);
        if (status != 0 || descriptor_ < 0)
            throw Error(systemErrorMessage("cannot exclusively create file", path, status));
#else
        int flags = O_WRONLY | O_CREAT | O_EXCL;
#ifdef O_CLOEXEC
        flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
        flags |= O_NOFOLLOW;
#endif
        do {
            descriptor_ = ::open(path.c_str(), flags, S_IRUSR | S_IWUSR);
        } while (descriptor_ < 0 && errno == EINTR);
        if (descriptor_ < 0)
            throw Error(systemErrorMessage("cannot exclusively create file", path, errno));
#endif
    }

    ExclusiveFile(const ExclusiveFile&) = delete;
    ExclusiveFile& operator=(const ExclusiveFile&) = delete;

    ~ExclusiveFile() { closeNoThrow(); }

    void writeAll(const void* data, std::size_t bytes) {
        const auto* cursor = static_cast<const unsigned char*>(data);
        while (bytes > 0) {
#if defined(_WIN32)
            const auto request = static_cast<unsigned int>(std::min<std::size_t>(
                bytes, static_cast<std::size_t>(std::numeric_limits<unsigned int>::max())));
            const auto written = _write(descriptor_, cursor, request);
            if (written <= 0)
                throw Error(systemErrorMessage("failed writing file", path_, errno));
#else
            const auto request = std::min<std::size_t>(
                bytes, static_cast<std::size_t>(std::numeric_limits<ssize_t>::max()));
            ssize_t written = -1;
            do {
                written = ::write(descriptor_, cursor, request);
            } while (written < 0 && errno == EINTR);
            if (written <= 0)
                throw Error(systemErrorMessage("failed writing file", path_, errno));
#endif
            const auto amount = static_cast<std::size_t>(written);
            cursor += amount;
            bytes -= amount;
        }
    }

    void seek(std::int64_t offset) {
#if defined(_WIN32)
        if (_lseeki64(descriptor_, offset, SEEK_SET) < 0)
            throw Error(systemErrorMessage("failed seeking file", path_, errno));
#else
        if (::lseek(descriptor_, static_cast<off_t>(offset), SEEK_SET) < 0)
            throw Error(systemErrorMessage("failed seeking file", path_, errno));
#endif
    }

    void flush() {
#if defined(_WIN32)
        if (_commit(descriptor_) != 0)
            throw Error(systemErrorMessage("failed flushing file", path_, errno));
#else
        int status = -1;
        do {
            status = ::fsync(descriptor_);
        } while (status != 0 && errno == EINTR);
        if (status != 0)
            throw Error(systemErrorMessage("failed flushing file", path_, errno));
#endif
    }

    void close() {
        if (descriptor_ < 0)
            return;
        const auto descriptor = std::exchange(descriptor_, -1);
#if defined(_WIN32)
        if (_close(descriptor) != 0)
#else
        if (::close(descriptor) != 0)
#endif
            throw Error(systemErrorMessage("failed closing file", path_, errno));
    }

    void closeNoThrowForOwner() noexcept { closeNoThrow(); }

  private:
    void closeNoThrow() noexcept {
        if (descriptor_ < 0)
            return;
        const auto descriptor = std::exchange(descriptor_, -1);
#if defined(_WIN32)
        static_cast<void>(_close(descriptor));
#else
        static_cast<void>(::close(descriptor));
#endif
    }

    fs::path path_;
    int descriptor_ = -1;
};

void writeU16(ExclusiveFile& output, std::uint16_t value) {
    std::array<unsigned char, 2> bytes{
        static_cast<unsigned char>(value & 0xffU),
        static_cast<unsigned char>((value >> 8U) & 0xffU),
    };
    output.writeAll(bytes.data(), bytes.size());
}

void writeU32(ExclusiveFile& output, std::uint32_t value) {
    std::array<unsigned char, 4> bytes{
        static_cast<unsigned char>(value & 0xffU),
        static_cast<unsigned char>((value >> 8U) & 0xffU),
        static_cast<unsigned char>((value >> 16U) & 0xffU),
        static_cast<unsigned char>((value >> 24U) & 0xffU),
    };
    output.writeAll(bytes.data(), bytes.size());
}

std::uint16_t readU16(BoundRegularFile& input) {
    std::array<unsigned char, 2> bytes{};
    input.readExact(bytes.data(), bytes.size());
    const auto value = static_cast<std::uint32_t>(bytes[0]) |
                       (static_cast<std::uint32_t>(bytes[1]) << 8U);
    return static_cast<std::uint16_t>(value);
}

std::uint32_t readU32(BoundRegularFile& input) {
    std::array<unsigned char, 4> bytes{};
    input.readExact(bytes.data(), bytes.size());
    return static_cast<std::uint32_t>(bytes[0]) |
           (static_cast<std::uint32_t>(bytes[1]) << 8U) |
           (static_cast<std::uint32_t>(bytes[2]) << 16U) |
           (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

std::string readFourCc(BoundRegularFile& input) {
    std::array<char, 4> value{};
    input.readExact(value.data(), value.size());
    return {value.data(), value.size()};
}

#if defined(OPUSLOOPS_RENDER_TESTING)
class TestSourcePathSwap {
  public:
    TestSourcePathSwap(const fs::path& original, const fs::path& replacement)
        : original_(original), replacement_(replacement),
          backup_(original.string() + ".opusloops-test-original") {
        if (replacement_.empty())
            return;
        if (!replacement_.is_absolute() || replacement_.parent_path() != original_.parent_path() ||
            !fs::is_regular_file(replacement_) || fs::is_symlink(replacement_))
            throw Error("test source replacement must be an adjacent regular file");
        if (fs::exists(backup_))
            throw Error("test source backup path already exists");
        std::error_code error;
        fs::rename(original_, backup_, error);
        if (error)
            throw Error("cannot move original source for test swap: " + error.message());
        fs::rename(replacement_, original_, error);
        if (error) {
            std::error_code ignored;
            fs::rename(backup_, original_, ignored);
            throw Error("cannot install replacement source for test swap: " + error.message());
        }
        active_ = true;
    }

    TestSourcePathSwap(const TestSourcePathSwap&) = delete;
    TestSourcePathSwap& operator=(const TestSourcePathSwap&) = delete;

    ~TestSourcePathSwap() { restoreNoThrow(); }

    void restore() {
        if (!active_)
            return;
        std::error_code error;
        fs::rename(original_, replacement_, error);
        if (error)
            throw Error("cannot remove replacement source after test swap: " + error.message());
        fs::rename(backup_, original_, error);
        if (error)
            throw Error("cannot restore original source after test swap: " + error.message());
        active_ = false;
    }

  private:
    void restoreNoThrow() noexcept {
        if (!active_)
            return;
        std::error_code ignored;
        if (!fs::exists(replacement_, ignored))
            fs::rename(original_, replacement_, ignored);
        ignored.clear();
        if (!fs::exists(original_, ignored))
            fs::rename(backup_, original_, ignored);
        active_ = false;
    }

    fs::path original_;
    fs::path replacement_;
    fs::path backup_;
    bool active_ = false;
};
#endif

class WavReader {
  public:
    explicit WavReader(const fs::path& path)
        : WavReader(path, path.filename().string(), std::string{}) {}

    WavReader(fs::path path, std::string assetId, std::string expectedSha256,
              const fs::path& testSwapReplacement = {})
        : path_(std::move(path)), assetId_(std::move(assetId)),
          expectedSha256_(std::move(expectedSha256)),
          input_(path_, "canonical WAV " + assetId_) {
        if (!expectedSha256_.empty()) {
            const auto initialSha256 = input_.sha256AndVerify();
            if (initialSha256 != expectedSha256_)
                throw Error("canonical WAV SHA-256 does not match stems manifest: " + assetId_);
        }
#if defined(OPUSLOOPS_RENDER_TESTING)
        TestSourcePathSwap testSwap(path_, testSwapReplacement);
#else
        static_cast<void>(testSwapReplacement);
#endif
        parse();
#if defined(OPUSLOOPS_RENDER_TESTING)
        testSwap.restore();
#endif
        input_.verify();
    }

    int channels() const { return channels_; }
    int sampleRate() const { return sampleRate_; }
    std::int64_t frames() const { return frames_; }

    std::string reverifySha256() {
        const auto actual = input_.sha256AndVerify();
        if (!expectedSha256_.empty() && actual != expectedSha256_)
            throw Error("descriptor content SHA-256 changed");
        return actual;
    }

    void readFrames(std::int64_t start, int count, std::vector<std::vector<float>>& output) {
        if (start < 0 || count < 0)
            throw Error("negative WAV read range");
        output.assign(static_cast<std::size_t>(channels_),
                      std::vector<float>(static_cast<std::size_t>(count), 0.0F));
        if (count == 0 || start >= frames_)
            return;

        const auto available64 = std::min<std::int64_t>(count, frames_ - start);
        const auto available = static_cast<int>(available64);
        const auto byteCount64 = available64 * blockAlign_;
        if (static_cast<std::uint64_t>(byteCount64) >
            static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max()))
            throw Error("WAV read block is too large");

        std::vector<unsigned char> bytes(static_cast<std::size_t>(byteCount64));
        input_.seek(static_cast<std::uint64_t>(dataOffset_ + start * blockAlign_));
        input_.readExact(bytes.data(), bytes.size());

        const int bytesPerSample = bitsPerSample_ / 8;
        for (int frame = 0; frame < available; ++frame) {
            for (int channel = 0; channel < channels_; ++channel) {
                const auto offset = static_cast<std::size_t>(frame * blockAlign_ +
                                                             channel * bytesPerSample);
                float sample = 0.0F;
                if (audioFormat_ == 1 && bitsPerSample_ == 16) {
                    const auto word = static_cast<std::uint16_t>(bytes[offset]) |
                                      (static_cast<std::uint16_t>(bytes[offset + 1]) << 8U);
                    const auto signedWord = static_cast<std::int16_t>(word);
                    sample = static_cast<float>(signedWord) / 32768.0F;
                } else {
                    const auto word = static_cast<std::uint32_t>(bytes[offset]) |
                                      (static_cast<std::uint32_t>(bytes[offset + 1]) << 8U) |
                                      (static_cast<std::uint32_t>(bytes[offset + 2]) << 16U) |
                                      (static_cast<std::uint32_t>(bytes[offset + 3]) << 24U);
                    std::memcpy(&sample, &word, sizeof(sample));
                }
                if (!std::isfinite(sample))
                    throw Error("non-finite sample in WAV input: " + path_.string());
                output[static_cast<std::size_t>(channel)][static_cast<std::size_t>(frame)] = sample;
            }
        }
    }

  private:
    void parse() {
        if (input_.size() < 44)
            throw Error("WAV input is too short: " + path_.string());
        fileBytes_ = input_.size();
        input_.seek(0);

        if (readFourCc(input_) != "RIFF")
            throw Error("only little-endian RIFF WAV is supported: " + path_.string());
        static_cast<void>(readU32(input_));
        if (readFourCc(input_) != "WAVE")
            throw Error("invalid WAV form type: " + path_.string());

        bool sawFormat = false;
        bool sawData = false;
        while (input_.tell() + 8U <= fileBytes_) {
            const auto chunkId = readFourCc(input_);
            const auto chunkBytes = static_cast<std::uint64_t>(readU32(input_));
            const auto chunkData = input_.tell();
            if (chunkBytes > fileBytes_ - chunkData)
                throw Error("WAV chunk extends beyond file: " + path_.string());

            if (chunkId == "fmt ") {
                if (chunkBytes < 16)
                    throw Error("invalid WAV fmt chunk: " + path_.string());
                audioFormat_ = static_cast<int>(readU16(input_));
                channels_ = static_cast<int>(readU16(input_));
                sampleRate_ = static_cast<int>(readU32(input_));
                static_cast<void>(readU32(input_));
                blockAlign_ = static_cast<int>(readU16(input_));
                bitsPerSample_ = static_cast<int>(readU16(input_));
                sawFormat = true;
            } else if (chunkId == "data") {
                if (sawData)
                    throw Error("multiple WAV data chunks are not supported: " + path_.string());
                dataOffset_ = static_cast<std::int64_t>(chunkData);
                dataBytes_ = static_cast<std::int64_t>(chunkBytes);
                sawData = true;
            }

            const auto next = chunkData + chunkBytes + (chunkBytes & 1U);
            if (next > fileBytes_)
                throw Error("invalid WAV chunk padding: " + path_.string());
            input_.seek(next);
        }

        if (!sawFormat || !sawData)
            throw Error("WAV input is missing fmt or data chunk: " + path_.string());
        if (channels_ < 1 || channels_ > kMaxChannelsPerStem)
            throw Error("unsupported WAV channel count: " + path_.string());
        if (sampleRate_ < 8000 || sampleRate_ > 384000)
            throw Error("unsupported WAV sample rate: " + path_.string());
        const bool supported = (audioFormat_ == 1 && bitsPerSample_ == 16) ||
                               (audioFormat_ == 3 && bitsPerSample_ == 32);
        if (!supported)
            throw Error("WAV must be PCM16 or IEEE float32: " + path_.string());
        const int expectedAlign = channels_ * (bitsPerSample_ / 8);
        if (blockAlign_ != expectedAlign || dataBytes_ % blockAlign_ != 0)
            throw Error("invalid WAV block alignment: " + path_.string());
        frames_ = dataBytes_ / blockAlign_;
        if (frames_ <= 0)
            throw Error("WAV input has no audio frames: " + path_.string());
    }

    fs::path path_;
    std::string assetId_;
    std::string expectedSha256_;
    BoundRegularFile input_;
    std::uint64_t fileBytes_ = 0;
    int audioFormat_ = 0;
    int channels_ = 0;
    int sampleRate_ = 0;
    int blockAlign_ = 0;
    int bitsPerSample_ = 0;
    std::int64_t dataOffset_ = 0;
    std::int64_t dataBytes_ = 0;
    std::int64_t frames_ = 0;
};

void renameNoReplace(const fs::path& source, const fs::path& destination) {
#if defined(_WIN32)
    if (!MoveFileExW(source.c_str(), destination.c_str(), MOVEFILE_WRITE_THROUGH)) {
        const auto code = static_cast<int>(GetLastError());
        throw Error("cannot publish without overwriting: " + destination.string() + ": " +
                    std::error_code(code, std::system_category()).message());
    }
#elif defined(__APPLE__)
    if (::renamex_np(source.c_str(), destination.c_str(), RENAME_EXCL) != 0)
        throw Error(systemErrorMessage("cannot publish without overwriting", destination, errno));
#elif defined(__linux__) && defined(SYS_renameat2)
    if (::syscall(SYS_renameat2, AT_FDCWD, source.c_str(), AT_FDCWD,
                  destination.c_str(), RENAME_NOREPLACE) != 0)
        throw Error(systemErrorMessage("cannot publish without overwriting", destination, errno));
#else
    static_cast<void>(source);
    static_cast<void>(destination);
    throw Error("atomic no-replace publication is unsupported on this platform");
#endif
}

class WavWriter {
  public:
    WavWriter(fs::path finalPath, int channels, int sampleRate)
        : finalPath_(std::move(finalPath)), partialPath_(finalPath_.string() + ".partial"),
          channels_(channels), sampleRate_(sampleRate), output_(partialPath_) {
        try {
            writeHeader();
        } catch (...) {
            output_.closeNoThrowForOwner();
            std::error_code ignored;
            fs::remove(partialPath_, ignored);
            throw;
        }
    }

    WavWriter(const WavWriter&) = delete;
    WavWriter& operator=(const WavWriter&) = delete;

    ~WavWriter() {
        if (finished_)
            return;
        output_.closeNoThrowForOwner();
        std::error_code ignored;
        fs::remove(partialPath_, ignored);
    }

    void writeFrames(const std::vector<std::vector<float>>& planar, int firstChannel, int count) {
        if (count < 0 || firstChannel < 0 ||
            firstChannel + channels_ > static_cast<int>(planar.size()))
            throw Error("invalid planar output slice");
        const auto nextFrames = framesWritten_ + count;
        const auto dataBytes = nextFrames * channels_ * static_cast<std::int64_t>(sizeof(float));
        if (dataBytes > static_cast<std::int64_t>(std::numeric_limits<std::uint32_t>::max()) - 36)
            throw Error("render output exceeds RIFF WAV size limit: " + finalPath_.string());

        std::vector<float> interleaved(static_cast<std::size_t>(count * channels_));
        for (int frame = 0; frame < count; ++frame) {
            for (int channel = 0; channel < channels_; ++channel) {
                const auto value = planar[static_cast<std::size_t>(firstChannel + channel)]
                                         [static_cast<std::size_t>(frame)];
                if (!std::isfinite(value))
                    throw Error("renderer produced a non-finite sample");
                interleaved[static_cast<std::size_t>(frame * channels_ + channel)] = value;
            }
        }
        output_.writeAll(interleaved.data(), interleaved.size() * sizeof(float));
        framesWritten_ = nextFrames;
    }

    std::int64_t framesWritten() const { return framesWritten_; }

    void finish() {
        if (finished_)
            return;
        const auto dataBytes64 = framesWritten_ * channels_ * static_cast<std::int64_t>(sizeof(float));
        if (dataBytes64 > static_cast<std::int64_t>(std::numeric_limits<std::uint32_t>::max()) - 36)
            throw Error("render output exceeds RIFF WAV size limit: " + finalPath_.string());
        const auto dataBytes = static_cast<std::uint32_t>(dataBytes64);
        output_.seek(4);
        writeU32(output_, 36U + dataBytes);
        output_.seek(40);
        writeU32(output_, dataBytes);
        output_.flush();
        output_.close();
        renameNoReplace(partialPath_, finalPath_);
        finished_ = true;
    }

  private:
    void writeHeader() {
        output_.writeAll("RIFF", 4);
        writeU32(output_, 0);
        output_.writeAll("WAVE", 4);
        output_.writeAll("fmt ", 4);
        writeU32(output_, 16);
        writeU16(output_, 3);
        writeU16(output_, static_cast<std::uint16_t>(channels_));
        writeU32(output_, static_cast<std::uint32_t>(sampleRate_));
        const auto blockAlign =
            static_cast<std::uint16_t>(channels_ * static_cast<int>(sizeof(float)));
        writeU32(output_, static_cast<std::uint32_t>(sampleRate_) * blockAlign);
        writeU16(output_, blockAlign);
        writeU16(output_, 32);
        output_.writeAll("data", 4);
        writeU32(output_, 0);
    }

    fs::path finalPath_;
    fs::path partialPath_;
    int channels_ = 0;
    int sampleRate_ = 0;
    ExclusiveFile output_;
    std::int64_t framesWritten_ = 0;
    bool finished_ = false;
};

bool pathEntryExists(const fs::path& path) {
    std::error_code error;
    const auto status = fs::symlink_status(path, error);
    if (!error)
        return status.type() != fs::file_type::not_found;
    if (error == std::errc::no_such_file_or_directory)
        return false;
    throw Error("cannot inspect output path: " + path.string() + ": " + error.message());
}

bool createPrivateDirectory(const fs::path& path) {
#if defined(_WIN32)
    if (CreateDirectoryW(path.c_str(), nullptr))
        return true;
    const auto code = static_cast<int>(GetLastError());
    if (code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS)
        return false;
    throw Error("cannot create render staging directory: " + path.string() + ": " +
                std::error_code(code, std::system_category()).message());
#else
    if (::mkdir(path.c_str(), S_IRWXU) == 0)
        return true;
    if (errno == EEXIST)
        return false;
    throw Error(systemErrorMessage("cannot create render staging directory", path, errno));
#endif
}

std::string makeLeaseToken() {
    std::random_device entropy;
    std::uint64_t high = static_cast<std::uint64_t>(entropy()) << 32U;
    high ^= static_cast<std::uint64_t>(entropy());
    std::uint64_t low = static_cast<std::uint64_t>(entropy()) << 32U;
    low ^= static_cast<std::uint64_t>(entropy());
    low ^= static_cast<std::uint64_t>(
        std::chrono::steady_clock::now().time_since_epoch().count());
    std::ostringstream token;
    token << std::hex << std::setfill('0') << std::setw(16) << high << std::setw(16) << low;
    return token.str();
}

class OwnedStagingDirectory {
  public:
    explicit OwnedStagingDirectory(fs::path finalPath) : finalPath_(std::move(finalPath)) {
        if (!finalPath_.is_absolute() || finalPath_.filename().empty())
            throw Error("render output directory must be an absolute, named path");
        if (pathEntryExists(finalPath_))
            throw Error("render output already exists: " + finalPath_.string());

        const auto parent = finalPath_.parent_path();
        std::error_code createError;
        fs::create_directories(parent, createError);
        if (createError)
            throw Error("cannot create render output parent: " + parent.string() + ": " +
                        createError.message());
        if (!fs::is_directory(parent))
            throw Error("render output parent is not a directory: " + parent.string());

        for (int attempt = 0; attempt < 64; ++attempt) {
            token_ = makeLeaseToken();
            path_ = parent / (".opusloops-render-staging-" + token_);
            if (!createPrivateDirectory(path_))
                continue;
            leasePayload_ = "opusloops-render-lease-v1\n" + token_ + "\n" +
                            finalPath_.lexically_normal().string() + "\n";
            try {
                ExclusiveFile lease(path_ / kLeaseFileName);
                lease.writeAll(leasePayload_.data(), leasePayload_.size());
                lease.flush();
                lease.close();
                active_ = true;
                return;
            } catch (...) {
                std::error_code ignored;
                fs::remove_all(path_, ignored);
                throw;
            }
        }
        throw Error("cannot allocate a unique render staging directory");
    }

    OwnedStagingDirectory(const OwnedStagingDirectory&) = delete;
    OwnedStagingDirectory& operator=(const OwnedStagingDirectory&) = delete;

    ~OwnedStagingDirectory() { cleanupOwned(); }

    const fs::path& path() const { return path_; }
    const fs::path& finalPath() const { return finalPath_; }

    bool leaseMatches() const {
        const auto leasePath = path_ / kLeaseFileName;
        if (!fs::is_regular_file(leasePath) || fs::is_symlink(leasePath))
            return false;
        std::ifstream input(leasePath, std::ios::binary);
        if (!input)
            return false;
        const std::string content((std::istreambuf_iterator<char>(input)),
                                  std::istreambuf_iterator<char>());
        return content == leasePayload_;
    }

    void publish() {
        if (!active_ || !leaseMatches())
            throw Error("render staging lease is missing or changed");
        renameNoReplace(path_, finalPath_);
        active_ = false;
        std::error_code ignored;
        fs::remove(finalPath_ / kLeaseFileName, ignored);
    }

  private:
    void cleanupOwned() noexcept {
        if (!active_)
            return;
        try {
            if (leaseMatches()) {
                std::error_code ignored;
                fs::remove_all(path_, ignored);
            }
        } catch (...) {
            // Cleanup is best effort. A future invocation uses a new lease-scoped
            // staging name and never scans or deletes an older invocation's state.
        }
        active_ = false;
    }

    fs::path finalPath_;
    fs::path path_;
    std::string token_;
    std::string leasePayload_;
    bool active_ = false;
};

#if defined(OPUSLOOPS_RENDER_TESTING)
void createTestPublicationCollision(const fs::path& finalPath) {
    if (!createPrivateDirectory(finalPath))
        throw Error("test publication collision path already exists");
    ExclusiveFile sentinel(finalPath / "external-owner.txt");
    constexpr std::array<char, 15> content{
        'e', 'x', 't', 'e', 'r', 'n', 'a', 'l', '-', 'o', 'w', 'n', 'e', 'r', '\n'};
    sentinel.writeAll(content.data(), content.size());
    sentinel.flush();
    sentinel.close();
}
#endif

struct Stem {
    std::string assetId;
    int channels = 0;
    std::int64_t declaredFrames = 0;
    std::string sha256;
    fs::path path;
    std::unique_ptr<WavReader> reader;
};

struct Anchor {
    std::int64_t source = 0;
    std::int64_t target = 0;
};

std::vector<std::string> splitTabs(const std::string& line) {
    std::vector<std::string> fields;
    std::size_t begin = 0;
    while (true) {
        const auto tab = line.find('\t', begin);
        fields.push_back(line.substr(begin, tab == std::string::npos ? tab : tab - begin));
        if (tab == std::string::npos)
            break;
        begin = tab + 1;
    }
    return fields;
}

std::int64_t parsePositiveInteger(const std::string& value, const std::string& label) {
    if (value.empty() || !std::all_of(value.begin(), value.end(), [](unsigned char c) {
            return std::isdigit(c) != 0;
        }))
        throw Error("invalid " + label + ": " + value);
    std::size_t parsed = 0;
    const auto result = std::stoll(value, &parsed);
    if (parsed != value.size() || result <= 0)
        throw Error("invalid " + label + ": " + value);
    return result;
}

bool validAssetId(const std::string& value) {
    if (value.empty() || value.size() > 128 || !std::isalnum(static_cast<unsigned char>(value[0])))
        return false;
    return std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return std::isalnum(c) != 0 || c == '-' || c == '_' || c == '.';
    });
}

std::vector<Stem> loadStems(const std::string& manifestContent, int sampleRate,
                            const fs::path& testSwapFirstSourceWith = {}) {
    std::istringstream input(manifestContent);
    std::string line;
    if (!std::getline(input, line) ||
        line != "asset_id\tchannels\tframes\tsha256\tpath")
        throw Error("invalid stems manifest header");

    std::unordered_set<std::string> ids;
    std::vector<Stem> stems;
    while (std::getline(input, line)) {
        if (line.empty())
            continue;
        const auto fields = splitTabs(line);
        if (fields.size() != 5)
            throw Error("invalid stems manifest row");
        if (!validAssetId(fields[0]) || !ids.insert(fields[0]).second)
            throw Error("invalid or duplicate asset_id: " + fields[0]);
        const auto channels = parsePositiveInteger(fields[1], "channel count");
        const auto frames = parsePositiveInteger(fields[2], "frame count");
        if (channels > kMaxChannelsPerStem)
            throw Error("stem channel count exceeds safety limit");
        if (!validSha256(fields[3]))
            throw Error("invalid stem SHA-256: " + fields[0]);
        fs::path path(fields[4]);
        if (!path.is_absolute())
            throw Error("stem path must be absolute: " + fields[4]);
        const auto testReplacement = stems.empty() ? testSwapFirstSourceWith : fs::path{};
        auto reader = std::make_unique<WavReader>(path, fields[0], fields[3], testReplacement);
        if (reader->channels() != channels || reader->frames() != frames ||
            reader->sampleRate() != sampleRate)
            throw Error("stem manifest does not match canonical WAV: " + fields[0]);
        stems.push_back({fields[0], static_cast<int>(channels), frames, fields[3],
                         std::move(path), std::move(reader)});
    }
    if (stems.empty())
        throw Error("stems manifest is empty");
    return stems;
}

std::vector<std::pair<std::string, std::string>> verifyStemHashes(
    const std::vector<Stem>& stems) {
    std::vector<std::pair<std::string, std::string>> verified;
    verified.reserve(stems.size());
    for (const auto& stem : stems) {
        try {
            const auto actual = stem.reader->reverifySha256();
            if (actual != stem.sha256)
                throw Error("descriptor hash no longer matches the stem manifest");
            verified.emplace_back(stem.assetId, actual);
        } catch (const std::exception& error) {
            throw Error("canonical WAV SHA-256 changed during rendering: " + stem.assetId +
                        ": " + error.what());
        }
    }
    return verified;
}

#if defined(OPUSLOOPS_RENDER_TESTING)
void tamperFirstSourceForTest(const std::vector<Stem>& stems) {
    if (stems.empty())
        throw Error("test source tamper requires a stem");
    std::ofstream output(stems.front().path, std::ios::binary | std::ios::app);
    if (!output)
        throw Error("cannot open test source for tampering");
    output.put('\0');
    output.flush();
    if (!output)
        throw Error("cannot tamper test source");
}
#endif

void validateStagedOutputs(const OwnedStagingDirectory& staging,
                           const std::vector<Stem>& stems, int sampleRate,
                           std::int64_t targetFrames) {
    if (!staging.leaseMatches())
        throw Error("render staging lease is missing or changed");

    std::unordered_set<std::string> expectedNames;
    for (const auto& stem : stems)
        expectedNames.insert(stem.assetId + ".wav");

    std::unordered_set<std::string> foundNames;
    for (const auto& entry : fs::directory_iterator(staging.path())) {
        const auto name = entry.path().filename().string();
        if (name == kLeaseFileName)
            continue;
        if (expectedNames.find(name) == expectedNames.end())
            throw Error("unexpected file in render staging directory: " + name);
        if (entry.is_symlink() || !entry.is_regular_file())
            throw Error("staged render is not a non-symlink regular file: " + name);
        if (!foundNames.insert(name).second)
            throw Error("duplicate file in render staging directory: " + name);
    }
    if (foundNames != expectedNames)
        throw Error("render staging directory does not contain the complete output set");

    for (const auto& stem : stems) {
        const auto path = staging.path() / (stem.assetId + ".wav");
        WavReader rendered(path);
        if (rendered.channels() != stem.channels || rendered.sampleRate() != sampleRate ||
            rendered.frames() != targetFrames)
            throw Error("staged render metadata does not match the render plan: " + stem.assetId);
        const auto expectedBytes = 44ULL + static_cast<std::uint64_t>(targetFrames) *
                                               static_cast<std::uint64_t>(stem.channels) * 4ULL;
        if (fs::file_size(path) != expectedBytes)
            throw Error("staged render byte length does not match its WAV header: " + stem.assetId);
    }
}

std::vector<Anchor> loadMap(const std::string& mapContent) {
    std::istringstream input(mapContent);
    std::string line;
    if (!std::getline(input, line) || line != "source_frame\ttarget_frame")
        throw Error("invalid frame map header");
    std::vector<Anchor> anchors;
    while (std::getline(input, line)) {
        if (line.empty())
            continue;
        const auto fields = splitTabs(line);
        if (fields.size() != 2)
            throw Error("invalid frame map row");
        if (fields[0] == "0" && fields[1] == "0") {
            anchors.push_back({0, 0});
            continue;
        }
        anchors.push_back({parsePositiveInteger(fields[0], "source frame"),
                           parsePositiveInteger(fields[1], "target frame")});
    }
    if (anchors.size() < 2 || anchors.front().source != 0 || anchors.front().target != 0)
        throw Error("frame map must begin at source 0, target 0 and contain at least two anchors");
    for (std::size_t index = 1; index < anchors.size(); ++index) {
        const auto sourceDelta = anchors[index].source - anchors[index - 1].source;
        const auto targetDelta = anchors[index].target - anchors[index - 1].target;
        if (sourceDelta <= 0 || targetDelta <= 0)
            throw Error("frame map anchors must be strictly increasing");
        const auto rate = static_cast<double>(sourceDelta) / static_cast<double>(targetDelta);
        if (rate < kMinPlaybackRate || rate > kMaxPlaybackRate)
            throw Error("frame map playback rate is outside the 0.25x to 4x safety range");
    }
    return anchors;
}

struct UnsignedRatioResult {
    std::uint64_t value = 0;
    bool overflow = false;
};

constexpr UnsignedRatioResult roundedUnsignedRatio(std::uint64_t value,
                                                    std::uint64_t numerator,
                                                    std::uint64_t denominator) {
    if (denominator == 0)
        return {0, true};

    constexpr auto limit = static_cast<std::uint64_t>(
        std::numeric_limits<std::int64_t>::max());
    const auto numeratorWhole = numerator / denominator;
    const auto numeratorRemainder = numerator % denominator;
    std::uint64_t quotient = 0;
    std::uint64_t remainder = 0;

    // Binary long division computes value*numerator/denominator without ever
    // materialising the potentially 126-bit product.
    for (int bit = 62; bit >= 0; --bit) {
        if (quotient > limit / 2)
            return {0, true};
        quotient *= 2;

        std::uint64_t carry = 0;
        if (remainder >= denominator - remainder) {
            remainder -= denominator - remainder;
            carry = 1;
        } else {
            remainder += remainder;
        }

        if ((value & (std::uint64_t{1} << bit)) != 0) {
            if (quotient > limit - numeratorWhole)
                return {0, true};
            quotient += numeratorWhole;
            if (remainder >= denominator - numeratorRemainder) {
                remainder -= denominator - numeratorRemainder;
                ++carry;
            } else {
                remainder += numeratorRemainder;
            }
        }

        if (quotient > limit - carry)
            return {0, true};
        quotient += carry;
    }

    const auto halfUpThreshold = denominator / 2 + denominator % 2;
    if (remainder >= halfUpThreshold) {
        if (quotient == limit)
            return {0, true};
        ++quotient;
    }
    return {quotient, false};
}

static_assert(!roundedUnsignedRatio(499999999, 999990049, 999999998).overflow &&
                  roundedUnsignedRatio(499999999, 999990049, 999999998).value == 499995025,
              "frame interpolation must use exact half-up rounding");
static_assert(roundedUnsignedRatio(1, 1, 2).value == 1,
              "half-frame interpolation must round upward");

std::int64_t roundedRatio(std::int64_t value, std::int64_t numerator,
                          std::int64_t denominator) {
    if (value < 0 || numerator <= 0 || denominator <= 0)
        throw Error("invalid interpolation ratio");
    const auto result = roundedUnsignedRatio(static_cast<std::uint64_t>(value),
                                             static_cast<std::uint64_t>(numerator),
                                             static_cast<std::uint64_t>(denominator));
    if (result.overflow)
        throw Error("frame interpolation overflow");
    return static_cast<std::int64_t>(result.value);
}

std::size_t segmentForTarget(const std::vector<Anchor>& anchors, std::int64_t target) {
    if (target < 0 || target > anchors.back().target)
        throw Error("target frame is outside map");
    if (target == anchors.back().target)
        return anchors.size() - 2;
    const auto found = std::upper_bound(
        anchors.begin(), anchors.end(), target,
        [](std::int64_t value, const Anchor& anchor) { return value < anchor.target; });
    return static_cast<std::size_t>(std::distance(anchors.begin(), found) - 1);
}

std::int64_t sourceAtTarget(const std::vector<Anchor>& anchors, std::int64_t target) {
    const auto segment = segmentForTarget(anchors, target);
    const auto& start = anchors[segment];
    const auto& end = anchors[segment + 1];
    return start.source + roundedRatio(target - start.target, end.source - start.source,
                                       end.target - start.target);
}

std::int64_t sourceAtTargetExtended(const std::vector<Anchor>& anchors,
                                    std::int64_t target) {
    if (target <= anchors.back().target)
        return sourceAtTarget(anchors, target);

    const auto& start = anchors[anchors.size() - 2];
    const auto& end = anchors.back();
    return end.source + roundedRatio(target - end.target, end.source - start.source,
                                     end.target - start.target);
}

struct RenderMember {
    Stem* stem = nullptr;
    std::unique_ptr<WavWriter> writer;
    int firstChannel = 0;
};

struct FaultInjector {
    int failAfterWriter = 0;
    int finishedWriters = 0;

    void afterWriterFinished() {
        ++finishedWriters;
        if (failAfterWriter > 0 && finishedWriters == failAfterWriter)
            throw Error("test-only injected failure after writer " +
                        std::to_string(finishedWriters));
    }
};

void readGroup(const std::vector<RenderMember>& members, std::int64_t sourceFrame, int count,
               std::vector<std::vector<float>>& flattened) {
    flattened.clear();
    for (const auto& member : members) {
        std::vector<std::vector<float>> stemAudio;
        member.stem->reader->readFrames(sourceFrame, count, stemAudio);
        for (auto& channel : stemAudio)
            flattened.push_back(std::move(channel));
    }
}

std::vector<const float*> constPointers(const std::vector<std::vector<float>>& buffers) {
    std::vector<const float*> result;
    result.reserve(buffers.size());
    for (const auto& channel : buffers)
        result.push_back(channel.data());
    return result;
}

std::vector<float*> mutablePointers(std::vector<std::vector<float>>& buffers) {
    std::vector<float*> result;
    result.reserve(buffers.size());
    for (auto& channel : buffers)
        result.push_back(channel.data());
    return result;
}

void writeGroup(std::vector<RenderMember>& members,
                const std::vector<std::vector<float>>& output, int count) {
    for (auto& member : members)
        member.writer->writeFrames(output, member.firstChannel, count);
}

void renderGroup(std::vector<RenderMember>& members, const std::vector<Anchor>& anchors,
                 int sampleRate, FaultInjector& faultInjector) {
    int channelCount = 0;
    for (auto& member : members) {
        member.firstChannel = channelCount;
        channelCount += member.stem->channels;
    }
    if (channelCount <= 0 || channelCount > kMaxLinkedChannels)
        throw Error("linked renderer channel count exceeds safety limit");

    signalsmith::stretch::SignalsmithStretch<float> stretch(0);
    stretch.presetDefault(channelCount, static_cast<float>(sampleRate), true);
    stretch.setFormantBase(static_cast<float>(200.0 / sampleRate));
    stretch.setTransposeSemitones(0.0F);
    stretch.setFormantFactor(1.0F, true);

    const auto inputLatency = static_cast<std::int64_t>(stretch.inputLatency());
    const auto outputLatency = static_cast<std::int64_t>(stretch.outputLatency());
    const auto interval = static_cast<std::int64_t>(stretch.intervalSamples());
    if (outputLatency <= 0 || interval <= 0 || anchors.back().target <= interval)
        throw Error("source is too short to prime Signalsmith Stretch");

    // outputSeek can infer only one rate. Keep its whole look-ahead inside the
    // first constant-rate region instead of smearing an early map change across
    // the pre-roll.
    if (outputLatency >= anchors.back().target)
        throw Error("source is too short for a Signalsmith output pre-roll");
    const auto mappedPreRoll = sourceAtTarget(anchors, outputLatency);
    const auto preInput = inputLatency + mappedPreRoll;
    if (anchors.size() > 2 && preInput > anchors[1].source)
        throw Error("first map region is shorter than the Signalsmith pre-roll");
    if (preInput <= inputLatency || preInput >= anchors.back().source ||
        preInput > std::numeric_limits<int>::max())
        throw Error("source is too short for an aligned Signalsmith pre-roll");

    std::vector<std::vector<float>> input;
    readGroup(members, 0, static_cast<int>(preInput), input);
    const auto initialPointers = constPointers(input);
    stretch.outputSeek(initialPointers.data(), static_cast<int>(preInput));

    std::int64_t sourceCursor = preInput;
    std::int64_t outputTarget = 0;
    std::int64_t regularFrames = 0;
    const auto processTargetEnd = anchors.back().target - interval;
    while (outputTarget < processTargetEnd) {
        const auto controlTarget = outputTarget + outputLatency;
        auto segmentEnd = processTargetEnd;
        if (controlTarget < anchors.back().target) {
            const auto segment = segmentForTarget(anchors, controlTarget);
            segmentEnd = std::min(segmentEnd, anchors[segment + 1].target - outputLatency);
        }
        if (segmentEnd <= outputTarget)
            throw Error("invalid latency-shifted renderer segment");
        const auto outputCount64 =
            std::min<std::int64_t>(kOutputBlockFrames, segmentEnd - outputTarget);
        const auto nextTarget = outputTarget + outputCount64;
        const auto inputCount64 =
            sourceAtTargetExtended(anchors, nextTarget + outputLatency) -
            sourceAtTargetExtended(anchors, outputTarget + outputLatency);
        if (inputCount64 < 0 || inputCount64 > std::numeric_limits<int>::max())
            throw Error("invalid renderer input allocation");
        const auto inputCount = static_cast<int>(inputCount64);
        const auto outputCount = static_cast<int>(outputCount64);

        readGroup(members, sourceCursor, inputCount, input);
        auto inputPointers = constPointers(input);
        std::vector<std::vector<float>> output(
            static_cast<std::size_t>(channelCount),
            std::vector<float>(static_cast<std::size_t>(outputCount)));
        auto outputPointers = mutablePointers(output);
        stretch.process(inputPointers.data(), inputCount, outputPointers.data(), outputCount);
        writeGroup(members, output, outputCount);

        sourceCursor += inputCount64;
        outputTarget = nextTarget;
        regularFrames += outputCount;
    }

    const auto expectedSourceCursor =
        preInput + sourceAtTargetExtended(anchors, processTargetEnd + outputLatency) -
        mappedPreRoll;
    if (sourceCursor != expectedSourceCursor)
        throw Error("renderer did not consume the latency-shifted source schedule");

    // All rate decisions, including those governing the delayed tail, have now
    // been applied through process(). Only one non-advancing STFT interval is
    // left for flush(), so it cannot flatten a piecewise map into one rate.
    const auto flushCount = static_cast<int>(interval);
    std::vector<std::vector<float>> tail(
        static_cast<std::size_t>(channelCount),
        std::vector<float>(static_cast<std::size_t>(flushCount)));
    auto tailPointers = mutablePointers(tail);
    stretch.flush(tailPointers.data(), flushCount);
    writeGroup(members, tail, flushCount);

    if (regularFrames + interval != anchors.back().target)
        throw Error("renderer did not produce the exact mapped target length");
    for (auto& member : members) {
        if (member.writer->framesWritten() != anchors.back().target)
            throw Error("stem render length does not match target frame count");
        member.writer->finish();
        faultInjector.afterWriterFinished();
    }
}

struct Options {
    fs::path stems;
    fs::path map;
    fs::path outputDirectory;
    std::string mode;
    std::string planSha256;
    std::string stemsTsvSha256;
    std::string mapTsvSha256;
    int sampleRate = 0;
    int testFailAfterWriter = 0;
    bool testCreateFinalBeforePublish = false;
    bool testTamperSourceBeforePublish = false;
    fs::path testSwapFirstSourceWith;
};

Options parseOptions(int argc, char** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string key(argv[index]);
        if (index + 1 >= argc)
            throw Error("missing value for option: " + key);
        const std::string value(argv[++index]);
        if (key == "--stems")
            options.stems = value;
        else if (key == "--map")
            options.map = value;
        else if (key == "--output-dir")
            options.outputDirectory = value;
        else if (key == "--mode")
            options.mode = value;
        else if (key == "--sample-rate")
            options.sampleRate = static_cast<int>(parsePositiveInteger(value, "sample rate"));
        else if (key == "--plan-sha256")
            options.planSha256 = value;
        else if (key == "--stems-tsv-sha256")
            options.stemsTsvSha256 = value;
        else if (key == "--map-tsv-sha256")
            options.mapTsvSha256 = value;
#if defined(OPUSLOOPS_RENDER_TESTING)
        else if (key == "--test-fail-after-writer") {
            const auto writer = parsePositiveInteger(value, "test failure writer");
            if (writer > std::numeric_limits<int>::max())
                throw Error("test failure writer exceeds supported range");
            options.testFailAfterWriter = static_cast<int>(writer);
        } else if (key == "--test-create-final-before-publish") {
            if (value != "1")
                throw Error("test publication collision must be 1");
            options.testCreateFinalBeforePublish = true;
        } else if (key == "--test-tamper-source-before-publish") {
            if (value != "1")
                throw Error("test source tamper must be 1");
            options.testTamperSourceBeforePublish = true;
        } else if (key == "--test-swap-first-source-with") {
            options.testSwapFirstSourceWith = fs::path(value);
            if (!options.testSwapFirstSourceWith.is_absolute())
                throw Error("test source replacement path must be absolute");
        }
#endif
        else
            throw Error("unknown option: " + key);
    }
    if (options.stems.empty() || options.map.empty() || options.outputDirectory.empty() ||
        (options.mode != "linked" && options.mode != "independent") ||
        options.sampleRate < 8000 || options.sampleRate > 384000 ||
        !validSha256(options.planSha256) || !validSha256(options.stemsTsvSha256) ||
        !validSha256(options.mapTsvSha256))
        throw Error("usage: opusloops-signalsmith-render --stems FILE --map FILE "
                    "--output-dir DIR --mode linked|independent --sample-rate HZ "
                    "--plan-sha256 HEX --stems-tsv-sha256 HEX --map-tsv-sha256 HEX");
    return options;
}

int run(int argc, char** argv) {
    const auto startedAt = std::chrono::steady_clock::now();
    const auto options = parseOptions(argc, argv);
    const auto stemsContent =
        readBoundRegularFile(options.stems, "stems manifest", kMaxRendererInputBytes);
    const auto actualStemsTsvSha256 = sha256Bytes(stemsContent);
    if (actualStemsTsvSha256 != options.stemsTsvSha256)
        throw Error("stems manifest SHA-256 does not match --stems-tsv-sha256");
    const auto mapContent =
        readBoundRegularFile(options.map, "frame map", kMaxRendererInputBytes);
    const auto actualMapTsvSha256 = sha256Bytes(mapContent);
    if (actualMapTsvSha256 != options.mapTsvSha256)
        throw Error("frame map SHA-256 does not match --map-tsv-sha256");

    auto stems =
        loadStems(stemsContent, options.sampleRate, options.testSwapFirstSourceWith);
    const auto anchors = loadMap(mapContent);
    const auto sourceFrames = std::max_element(
        stems.begin(), stems.end(),
        [](const Stem& left, const Stem& right) {
            return left.declaredFrames < right.declaredFrames;
        })->declaredFrames;
    if (anchors.back().source != sourceFrames)
        throw Error("frame map must end at the longest canonical stem frame");

    OwnedStagingDirectory staging(options.outputDirectory);
    FaultInjector faultInjector{options.testFailAfterWriter, 0};

    if (options.mode == "linked") {
        std::vector<RenderMember> members;
        int totalChannels = 0;
        for (auto& stem : stems) {
            totalChannels += stem.channels;
            const auto outputPath = staging.path() / (stem.assetId + ".wav");
            members.push_back({&stem,
                               std::make_unique<WavWriter>(outputPath, stem.channels,
                                                           options.sampleRate),
                               0});
        }
        if (totalChannels > kMaxLinkedChannels)
            throw Error("linked renderer channel count exceeds safety limit");
        renderGroup(members, anchors, options.sampleRate, faultInjector);
    } else {
        for (auto& stem : stems) {
            const auto outputPath = staging.path() / (stem.assetId + ".wav");
            std::vector<RenderMember> member;
            member.push_back({&stem,
                              std::make_unique<WavWriter>(outputPath, stem.channels,
                                                          options.sampleRate),
                              0});
            renderGroup(member, anchors, options.sampleRate, faultInjector);
        }
    }

    validateStagedOutputs(staging, stems, options.sampleRate, anchors.back().target);
#if defined(OPUSLOOPS_RENDER_TESTING)
    if (options.testTamperSourceBeforePublish)
        tamperFirstSourceForTest(stems);
#endif
    const auto consumedStemSha256s = verifyStemHashes(stems);
#if defined(OPUSLOOPS_RENDER_TESTING)
    if (options.testCreateFinalBeforePublish)
        createTestPublicationCollision(staging.finalPath());
#endif
    staging.publish();

    const auto elapsed = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - startedAt).count();
    std::int64_t peakRssBytes = -1;
#if defined(__unix__) || defined(__APPLE__)
    struct rusage usage {};
    if (getrusage(RUSAGE_SELF, &usage) == 0) {
#if defined(__APPLE__)
        peakRssBytes = static_cast<std::int64_t>(usage.ru_maxrss);
#else
        peakRssBytes = static_cast<std::int64_t>(usage.ru_maxrss) * 1024;
#endif
    }
#endif
    std::cout << "{\"engine\":\"signalsmith-stretch\",\"version\":\"1.3.2\","
              << "\"mode\":\"" << options.mode << "\",\"source_frames\":"
              << anchors.back().source << ",\"target_frames\":" << anchors.back().target
              << ",\"stem_count\":" << stems.size() << ",\"plan_sha256\":\""
              << options.planSha256 << "\",\"stems_tsv_sha256\":\""
              << actualStemsTsvSha256 << "\",\"map_tsv_sha256\":\""
              << actualMapTsvSha256 << "\",\"stem_sha256s\":{";
    for (std::size_t index = 0; index < consumedStemSha256s.size(); ++index) {
        if (index > 0)
            std::cout << ',';
        std::cout << '\"' << consumedStemSha256s[index].first << "\":\""
                  << consumedStemSha256s[index].second << '\"';
    }
    std::cout << "},\"wall_seconds\":" << elapsed << ",\"peak_rss_bytes\":";
    if (peakRssBytes >= 0)
        std::cout << peakRssBytes;
    else
        std::cout << "null";
    std::cout << "}\n";
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        return run(argc, argv);
    } catch (const std::exception& error) {
        std::cerr << "opusloops-signalsmith-render: " << error.what() << '\n';
        return 2;
    }
}
