from setuptools import Distribution, setup
from wheel.bdist_wheel import bdist_wheel


class BinaryDistribution(Distribution):
    def has_ext_modules(self):
        return True


class PlatformWheel(bdist_wheel):
    def get_tag(self):
        _, _, platform = super().get_tag()
        return "py3", "none", platform


setup(
    name="cann_bench",
    version="1.0.0",
    packages=["cann_bench"],
    package_data={"cann_bench": ["libcanness-*.so"]},
    distclass=BinaryDistribution,
    cmdclass={"bdist_wheel": PlatformWheel},
    python_requires=">=3.8",
    zip_safe=False,
)
