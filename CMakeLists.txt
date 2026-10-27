# The Dado loader for Endless Sky: a shared library the game finds in its
# "modloaders" folder (see include/es_api.h and README.md).
#
#   cmake -B build -G Ninja && cmake --build build
#   ctest --test-dir build              the fake-host tests (needs node/npx or esbuild)
#   cmake --build build --target install-loader
#
# Needs the Dado toolchain (`dado` and `dadoc` on PATH, or DADO_EXECUTABLE /
# DADOC_EXECUTABLE), a C compiler, and git for the first build of the script
# engine (QuickJS-ng with Dado's patches, cached in ~/.cache/dado-quickjs).
cmake_minimum_required(VERSION 3.21)
project(esdado VERSION 0.1.0 LANGUAGES C)

include(CTest)

set(ESDADO_TRIPLE "" CACHE STRING
	"The target triple dadoc emits for (default: the C compiler's -dumpmachine; aarch64-apple-darwin for a macOS cross build).")
set(DADO_QJS_CACHE "$ENV{HOME}/.cache/dado-quickjs" CACHE PATH "Where Dado's script engine builds are cached.")

# IDEs often run CMake without the shell's PATH, so also look where the installer puts them.
set(_DADO_HINTS "$ENV{HOME}/.local/bin" "$ENV{HOME}/dado" "$ENV{LOCALAPPDATA}/dado/bin")
find_program(DADO_EXECUTABLE dado HINTS ${_DADO_HINTS} REQUIRED)
find_program(DADOC_EXECUTABLE dadoc HINTS ${_DADO_HINTS} REQUIRED)
get_filename_component(DADO_BIN_DIR "${DADO_EXECUTABLE}" DIRECTORY)

execute_process(COMMAND "${DADO_EXECUTABLE}" where --no-update-check
	OUTPUT_VARIABLE DADO_WHERE RESULT_VARIABLE DADO_WHERE_RESULT)
if(NOT DADO_WHERE_RESULT EQUAL 0)
	message(FATAL_ERROR "`dado where` failed; run `dado doctor`.")
endif()
string(REGEX MATCH "(^|\n)root=([^\n]*)" _ "${DADO_WHERE}")
set(DADO_ROOT "${CMAKE_MATCH_2}")
string(REGEX MATCH "(^|\n)collections=([^\n]*)" _ "${DADO_WHERE}")
set(DADO_COLLECTIONS "${CMAKE_MATCH_2}")

# The compiler as one command line (CMake splits "zig cc -target ..." into the
# program and its first argument).
set(ESDADO_CC "${CMAKE_C_COMPILER}")
if(CMAKE_C_COMPILER_ARG1)
	string(STRIP "${CMAKE_C_COMPILER_ARG1}" _arg1)
	set(ESDADO_CC "${ESDADO_CC} ${_arg1}")
endif()

# dadoc answers #OS and #ARCH from the target triple. --target is required: a
# build without it assumes BSD's arc4random_buf.
if(ESDADO_TRIPLE)
	set(DADO_TRIPLE "${ESDADO_TRIPLE}")
elseif(APPLE AND CMAKE_OSX_ARCHITECTURES)
	list(LENGTH CMAKE_OSX_ARCHITECTURES _n)
	if(_n GREATER 1)
		message(FATAL_ERROR "the loader builds for one architecture at a time; CMAKE_OSX_ARCHITECTURES is \"${CMAKE_OSX_ARCHITECTURES}\"")
	endif()
	set(_arch "${CMAKE_OSX_ARCHITECTURES}")
	if(_arch STREQUAL "arm64")
		set(_arch aarch64)
	endif()
	set(DADO_TRIPLE "${_arch}-apple-darwin")
else()
	separate_arguments(_cc_list UNIX_COMMAND "${ESDADO_CC}")
	execute_process(COMMAND ${_cc_list} -dumpmachine
		OUTPUT_VARIABLE DADO_TRIPLE OUTPUT_STRIP_TRAILING_WHITESPACE)
	if(APPLE AND DADO_TRIPLE MATCHES "^arm64-")
		string(REGEX REPLACE "^arm64-" "aarch64-" DADO_TRIPLE "${DADO_TRIPLE}")
	endif()
endif()
message(STATUS "esdado: dadoc target ${DADO_TRIPLE}")

# The script engine (QuickJS-ng with Dado's patches), built position-independent
# and with hidden symbols for a shared library; cached per compiler and flags.
set(_qjs_args --cc "${ESDADO_CC}" --extra "-fPIC -fvisibility=hidden")
if(CMAKE_CROSSCOMPILING OR ESDADO_TRIPLE)
	list(APPEND _qjs_args --compile-only)
endif()
message(STATUS "esdado: building the script engine with ${ESDADO_CC} (cached after the first time)")
execute_process(
	COMMAND ${CMAKE_COMMAND} -E env "DADO_QJS_CACHE=${DADO_QJS_CACHE}"
		sh "${DADO_ROOT}/tools/quickjs/build.sh" ${_qjs_args}
	OUTPUT_VARIABLE _qjs_out ERROR_VARIABLE _qjs_err RESULT_VARIABLE _qjs_result)
string(STRIP "${_qjs_out}" _qjs_out)
string(REGEX REPLACE ".*\n" "" DADO_QJS_DIR "${_qjs_out}")
if(NOT _qjs_result EQUAL 0 OR NOT EXISTS "${DADO_QJS_DIR}/libquickjs.a")
	message(FATAL_ERROR "Dado's script engine did not build:\n${_qjs_err}")
endif()
message(STATUS "esdado: script engine in ${DADO_QJS_DIR}")

set(GEN "${CMAKE_CURRENT_BINARY_DIR}/gen")
file(MAKE_DIRECTORY "${GEN}")

# The harness, transpiled to one C file and its header, with the max-align fix.
file(GLOB HARNESS_SOURCES CONFIGURE_DEPENDS
	"${CMAKE_CURRENT_SOURCE_DIR}/harness/*" "${CMAKE_CURRENT_SOURCE_DIR}/sdk/es/*")
set(_dadoc "${DADOC_EXECUTABLE}" --collections=${DADO_COLLECTIONS} --package --library --target=${DADO_TRIPLE})
add_custom_command(
	OUTPUT "${GEN}/esmod.c" "${GEN}/esmod.h"
	COMMAND ${_dadoc} --emit=c -o "${GEN}/esmod.c" "${CMAKE_CURRENT_SOURCE_DIR}/harness/entry.dado"
	COMMAND ${CMAKE_COMMAND} -DFILE=${GEN}/esmod.c -P "${CMAKE_CURRENT_SOURCE_DIR}/tools/fix-max-align.cmake"
	COMMAND ${_dadoc} --emit=h -o "${GEN}/esmod.h" "${CMAKE_CURRENT_SOURCE_DIR}/harness/entry.dado"
	DEPENDS ${HARNESS_SOURCES} "${CMAKE_CURRENT_SOURCE_DIR}/tools/fix-max-align.cmake"
	COMMENT "dadoc: transpiling the harness"
	VERBATIM)

# The host shim, generated from the game's API header.
add_custom_command(
	OUTPUT "${GEN}/es_host.h" "${GEN}/es_host_shim.c"
	COMMAND ${CMAKE_COMMAND} -DAPI=${CMAKE_CURRENT_SOURCE_DIR}/include/es_api.h -DOUT=${GEN}
		-P "${CMAKE_CURRENT_SOURCE_DIR}/tools/gen-host-shim.cmake"
	DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/include/es_api.h" "${CMAKE_CURRENT_SOURCE_DIR}/tools/gen-host-shim.cmake"
	COMMENT "esdado: generating the host shim from es_api.h"
	VERBATIM)

find_package(Threads REQUIRED)

add_library(esdado SHARED
	src/loader.c
	"${GEN}/esmod.c"
	"${GEN}/es_host_shim.c")
set_target_properties(esdado PROPERTIES
	C_STANDARD 11 C_STANDARD_REQUIRED ON C_EXTENSIONS OFF
	C_VISIBILITY_PRESET hidden POSITION_INDEPENDENT_CODE ON)
# libesdado.so / libesdado.dylib / esdado.dll.
if(WIN32)
	set_target_properties(esdado PROPERTIES PREFIX "")
endif()
target_compile_definitions(esdado PRIVATE _GNU_SOURCE "ESDADO_VERSION=\"${PROJECT_VERSION}\"")
target_include_directories(esdado PRIVATE include "${GEN}" "${DADO_QJS_DIR}")
# Generated code: warnings are not for it.
set_source_files_properties("${GEN}/esmod.c" PROPERTIES COMPILE_OPTIONS "-funsigned-char;-w")
if(NOT MSVC)
	set_source_files_properties(src/loader.c "${GEN}/es_host_shim.c" PROPERTIES COMPILE_OPTIONS "-Wall;-Wextra")
endif()
target_link_libraries(esdado PRIVATE "${DADO_QJS_DIR}/libquickjs.a" Threads::Threads)
# Export es_loader_init alone: the harness's esmod_* functions are dadoc's
# `export`s, visible by default, and stay inside the library. On macOS esmod.c
# takes DADO_EXPORT from the command line (zig's Mach-O linker has no
# -exported_symbol); on ELF targets a version script hides them.
if(APPLE)
	set_property(SOURCE "${GEN}/esmod.c" APPEND PROPERTY COMPILE_DEFINITIONS "DADO_EXPORT=__attribute__((used))")
	# A release dylib carries no debug map (stabs naming the build's absolute
	# paths), so two builds of the same sources are the same bytes.
	target_link_options(esdado PRIVATE "$<$<CONFIG:Release,MinSizeRel>:LINKER:-S>")
elseif(NOT WIN32)
	target_link_libraries(esdado PRIVATE m)
	target_link_options(esdado PRIVATE "LINKER:--no-undefined"
		"LINKER:--version-script=${CMAKE_CURRENT_SOURCE_DIR}/src/exports.map")
	set_property(TARGET esdado APPEND PROPERTY LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/exports.map")
endif()

# Copy the library into the game's modloaders folder for this user, or
# ESDADO_INSTALL_DIR when set.
set(ESDADO_INSTALL_DIR "" CACHE PATH "Where install-loader copies the library (default: the user's modloaders folder).")
set(_install_args "$<TARGET_FILE:esdado>")
if(ESDADO_INSTALL_DIR)
	list(APPEND _install_args --to "${ESDADO_INSTALL_DIR}")
endif()
add_custom_target(install-loader
	COMMAND sh "${CMAKE_CURRENT_SOURCE_DIR}/tools/install.sh" ${_install_args}
	DEPENDS esdado
	VERBATIM USES_TERMINAL)

# Working on mods: tools/dado-mods.sh with this build's toolchain.
set(DADO_MODS_ENV ${CMAKE_COMMAND} -E env "CC=${ESDADO_CC}" "DADO_QJS_CACHE=${DADO_QJS_CACHE}"
	"PATH=${DADO_BIN_DIR}:$ENV{PATH}" "ESDADO_LIB=$<TARGET_FILE:esdado>")
set(DADO_MODS_SH sh "${CMAKE_CURRENT_SOURCE_DIR}/tools/dado-mods.sh")
add_custom_target(dado_mods
	COMMAND ${DADO_MODS_ENV} ${DADO_MODS_SH} examples
	COMMENT "Rebuilding the example mods and the in-game test's scripts"
	VERBATIM USES_TERMINAL)
add_custom_target(dado_sdk
	COMMAND ${DADO_MODS_ENV} ${DADO_MODS_SH} sdk
	COMMENT "Regenerating sdk/es/game.dado from the harness"
	VERBATIM USES_TERMINAL)

if(BUILD_TESTING AND NOT CMAKE_CROSSCOMPILING AND NOT ESDADO_TRIPLE)
	add_test(NAME fake_host COMMAND ${DADO_MODS_ENV} ${DADO_MODS_SH} test)
	set_tests_properties(fake_host PROPERTIES TIMEOUT 600)
	add_test(NAME api_header_sync COMMAND sh "${CMAKE_CURRENT_SOURCE_DIR}/tools/sync-api.sh" --check)
	set_tests_properties(api_header_sync PROPERTIES SKIP_RETURN_CODE 77)
endif()
