cmake_minimum_required(VERSION 3.20)

project(opusloops_signalsmith_render LANGUAGES C CXX)

set(
  OPUSLOOPS_SHA256_DEPS
  "${CMAKE_CURRENT_LIST_DIR}/third_party/sha256"
)
add_executable(
  opusloops-signalsmith-render
  signalsmith_render.cpp
  "${OPUSLOOPS_SHA256_DEPS}/sha256.c"
)
target_compile_features(opusloops-signalsmith-render PRIVATE cxx_std_17)
target_include_directories(
  opusloops-signalsmith-render
  SYSTEM PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}/../../../third_party/signalsmith-stretch"
    "${OPUSLOOPS_SHA256_DEPS}"
)

if(MSVC)
  target_compile_options(opusloops-signalsmith-render PRIVATE /W4 /permissive-)
else()
  target_compile_options(
    opusloops-signalsmith-render
    PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wshadow
  )
endif()
