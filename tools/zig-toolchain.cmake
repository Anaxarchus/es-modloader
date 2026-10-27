# Shared by zig-macos.cmake, zig-linux.cmake and zig-windows.cmake: compile and link with
# `zig cc -target ${ZIG_TARGET}`, through a wrapper script written into the
# build folder with the target in it (so every compile gets it, whatever the
# environment), and archive with `zig ar`. ZIG names zig when it is not on PATH.
set(_zig "$ENV{ZIG}")
if(NOT _zig)
	set(_zig zig)
endif()
set(_wrapper_dir "${CMAKE_BINARY_DIR}/zig-wrappers")
file(MAKE_DIRECTORY "${_wrapper_dir}")
foreach(_tool cc ar ranlib)
	if(_tool STREQUAL "cc")
		set(_line "exec \"${_zig}\" cc -target ${ZIG_TARGET} \"$@\"")
		# A glibc-pinned target (x86_64-linux-gnu.2.28): clang prints the triple
		# for -dumpmachine and then fails on its glibc suffix, so answer it here.
		if(ZIG_TARGET MATCHES "^([^-]+)-linux-gnu[.][0-9.]+$")
			set(_line "if [ \"$#\" = 1 ] && [ \"$1\" = -dumpmachine ]; then echo ${CMAKE_MATCH_1}-unknown-linux-gnu; exit 0; fi\n${_line}")
		endif()
	else()
		set(_line "exec \"${_zig}\" ${_tool} \"$@\"")
	endif()
	# Named zig-* so Dado's engine build (tools/quickjs/build.sh) knows it for zig.
	file(WRITE "${_wrapper_dir}/zig-${_tool}" "#!/bin/sh\n${_line}\n")
	file(CHMOD "${_wrapper_dir}/zig-${_tool}" PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE)
endforeach()
set(CMAKE_C_COMPILER "${_wrapper_dir}/zig-cc")
set(CMAKE_AR "${_wrapper_dir}/zig-ar" CACHE FILEPATH "" FORCE)
set(CMAKE_RANLIB "${_wrapper_dir}/zig-ranlib" CACHE FILEPATH "" FORCE)
